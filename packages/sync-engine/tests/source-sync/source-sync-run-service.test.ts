import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import { SourceSyncRunServiceLive } from "../../src/layers/SourceSyncRunServiceLive.ts"
import {
  SourceRepository,
  SourceSyncQueueError,
  SourceSyncRunRepository,
  SourceSyncRunService,
  SourceSyncService,
  type SourceSyncRunDetails,
  type SourceSyncRunRepositoryShape,
  type SourceSyncServiceShape,
  type SourceSyncSource,
  type SyncRunItemRecord,
  type SyncRunRecord,
} from "../../src/services/index.ts"

const now = new Date("2026-01-01T00:00:00.000Z")

const coinbaseSource: SourceSyncSource = {
  id: "source-1",
  userId: "user-1",
  providerKey: "coinbase",
  cexAccountId: "cex-1",
  addressId: null,
}

const bitcoinSource: SourceSyncSource = {
  id: "source-2",
  userId: "user-1",
  providerKey: "bitcoin",
  cexAccountId: null,
  addressId: "address-1",
}

const sources: ReadonlyArray<SourceSyncSource> = [coinbaseSource, bitcoinSource]

const makeRun = ({
  id = "run-1",
  requestedSourceCount,
  status = requestedSourceCount === 0 ? "completed" : "queued",
  queuedSourceCount = 0,
  runningSourceCount = 0,
  completedSourceCount = 0,
  failedSourceCount = 0,
  message = requestedSourceCount === 0 ? "No sources to sync." : null,
}: {
  readonly id?: string
  readonly requestedSourceCount: number
  readonly status?: SyncRunRecord["status"]
  readonly queuedSourceCount?: number
  readonly runningSourceCount?: number
  readonly completedSourceCount?: number
  readonly failedSourceCount?: number
  readonly message?: string | null
}): SyncRunRecord => ({
  id,
  userId: "user-1",
  status,
  requestedSourceCount,
  queuedSourceCount,
  runningSourceCount,
  completedSourceCount,
  failedSourceCount,
  startedAt: now,
  completedAt:
    status === "completed" || status === "failed" || status === "partially_failed" ? now : null,
  message,
  createdAt: now,
  updatedAt: now,
})

const makeItem = ({
  runId = "run-1",
  source,
  jobId,
  status = "queued",
  message = null,
}: {
  readonly runId?: string
  readonly source: SourceSyncSource
  readonly jobId: string | null
  readonly status?: SyncRunItemRecord["status"]
  readonly message?: string | null
}): SyncRunItemRecord => ({
  id: `item-${source.id}`,
  runId,
  sourceId: source.id,
  processingJobId: jobId,
  provider: source.providerKey,
  status,
  importedRecords: null,
  normalizedRecords: null,
  failedRecords: null,
  message,
  createdAt: now,
  updatedAt: now,
})

const runStatusFromCounters = ({
  requestedSourceCount,
  runningSourceCount,
  completedSourceCount,
  failedSourceCount,
}: {
  readonly requestedSourceCount: number
  readonly runningSourceCount: number
  readonly completedSourceCount: number
  readonly failedSourceCount: number
}): SyncRunRecord["status"] => {
  if (requestedSourceCount === 0) {
    return "completed"
  }

  const terminalSourceCount = completedSourceCount + failedSourceCount

  if (terminalSourceCount === requestedSourceCount && failedSourceCount === requestedSourceCount) {
    return "failed"
  }

  if (terminalSourceCount === requestedSourceCount && failedSourceCount > 0) {
    return "partially_failed"
  }

  if (runningSourceCount > 0) {
    return "running"
  }

  return "queued"
}

const makeLayer = ({
  listedSources = sources,
  sourceSyncService,
  repositoryOverrides = {},
}: {
  readonly listedSources?: ReadonlyArray<SourceSyncSource>
  readonly sourceSyncService: SourceSyncServiceShape
  readonly repositoryOverrides?: Partial<SourceSyncRunRepositoryShape>
}) => {
  const attachedItems: Array<SyncRunItemRecord> = []
  const createdRun = makeRun({ requestedSourceCount: listedSources.length })

  const SourceRepositoryTestLive = Layer.succeed(SourceRepository, {
    findOwnedSourceSyncContext: () => Effect.succeed(Option.none()),
    listUserSourceSyncContexts: () => Effect.succeed(listedSources),
  })

  const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, sourceSyncService)

  const defaultRepository: SourceSyncRunRepositoryShape = {
    createRun: () => Effect.succeed(createdRun),
    attachRunItem: ({ runId, sourceId, processingJobId }) =>
      Effect.gen(function* () {
        const source = listedSources.find((candidate) => candidate.id === sourceId)
        if (source === undefined) {
          return yield* Effect.dieMessage(`Missing source ${sourceId}`)
        }
        const item = makeItem({ runId, source, jobId: processingJobId })
        attachedItems.push(item)
        return item
      }),
    recordRunItemFailure: ({ runId, sourceId, message }) =>
      Effect.gen(function* () {
        const source = listedSources.find((candidate) => candidate.id === sourceId)
        if (source === undefined) {
          return yield* Effect.dieMessage(`Missing source ${sourceId}`)
        }
        const item = makeItem({ runId, source, jobId: null, status: "failed", message })
        attachedItems.push(item)
        return item
      }),
    getRun: () => Effect.succeed(Option.some(createdRun)),
    getVisibleRun: () => Effect.succeed(Option.some(createdRun)),
    listRunItems: () => Effect.succeed(attachedItems),
    refreshRunStatus: () => {
      const queuedSourceCount = attachedItems.filter((item) => item.status === "queued").length
      const runningSourceCount = attachedItems.filter((item) => item.status === "running").length
      const completedSourceCount = attachedItems.filter(
        (item) => item.status === "completed"
      ).length
      const failedSourceCount = attachedItems.filter((item) => item.status === "failed").length
      const status = runStatusFromCounters({
        requestedSourceCount: listedSources.length,
        runningSourceCount,
        completedSourceCount,
        failedSourceCount,
      })

      return Effect.succeed(
        makeRun({
          requestedSourceCount: listedSources.length,
          status,
          queuedSourceCount,
          runningSourceCount,
          completedSourceCount,
          failedSourceCount,
        })
      )
    },
    ...repositoryOverrides,
  }

  const SourceSyncRunRepositoryTestLive = Layer.succeed(SourceSyncRunRepository, defaultRepository)

  return SourceSyncRunServiceLive.pipe(
    Layer.provide(SourceRepositoryTestLive),
    Layer.provide(SourceSyncServiceTestLive),
    Layer.provide(SourceSyncRunRepositoryTestLive)
  )
}

const runWithLayer = (layer: Layer.Layer<SourceSyncRunService>) =>
  Effect.runPromise(
    Effect.flatMap(SourceSyncRunService, (service) =>
      service.startSyncRun({ userId: "user-1" })
    ).pipe(Effect.provide(layer))
  )

describe("SourceSyncRunService", () => {
  it("starts one child source job per source and links run items", async () => {
    const startedSources: Array<string> = []

    const result = await runWithLayer(
      makeLayer({
        sourceSyncService: {
          startSourceSyncJob: ({ sourceId }) =>
            Effect.sync(() => {
              startedSources.push(sourceId)
              return {
                sourceId,
                jobId: `job-${sourceId}`,
                status: "queued",
                message: null,
              }
            }),
          replaySourceSyncJob: () => Effect.dieMessage("replaySourceSyncJob should not be called"),
          getSourceSyncJob: () => Effect.dieMessage("getSourceSyncJob should not be called"),
        },
      })
    )

    expect([...startedSources].sort()).toEqual(["source-1", "source-2"])
    expect(result.items.map((item) => item.processingJobId).sort()).toEqual([
      "job-source-1",
      "job-source-2",
    ])
  })

  it("returns a completed zero-source run", async () => {
    const result = await runWithLayer(
      makeLayer({
        listedSources: [],
        sourceSyncService: {
          startSourceSyncJob: () =>
            Effect.dieMessage("startSourceSyncJob should not be called for zero sources"),
          replaySourceSyncJob: () => Effect.dieMessage("replaySourceSyncJob should not be called"),
          getSourceSyncJob: () => Effect.dieMessage("getSourceSyncJob should not be called"),
        },
      })
    )

    expect(result).toMatchObject({
      status: "completed",
      requestedSourceCount: 0,
      message: "No sources to sync.",
      items: [],
    })
  })

  it("links an existing active source job returned by source sync service", async () => {
    const result = await runWithLayer(
      makeLayer({
        listedSources: [coinbaseSource],
        sourceSyncService: {
          startSourceSyncJob: ({ sourceId }) =>
            Effect.succeed({
              sourceId,
              jobId: "existing-active-job",
              status: "running",
              message: null,
            }),
          replaySourceSyncJob: () => Effect.dieMessage("replaySourceSyncJob should not be called"),
          getSourceSyncJob: () => Effect.dieMessage("getSourceSyncJob should not be called"),
        },
      })
    )

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.processingJobId).toBe("existing-active-job")
  })

  it("records queue failure from child source job start as a failed run item", async () => {
    const result = await runWithLayer(
      makeLayer({
        listedSources: [coinbaseSource],
        sourceSyncService: {
          startSourceSyncJob: () =>
            Effect.fail(
              new SourceSyncQueueError({
                operation: "test.enqueue",
                cause: "queue unavailable",
              })
            ),
          replaySourceSyncJob: () => Effect.dieMessage("replaySourceSyncJob should not be called"),
          getSourceSyncJob: () => Effect.dieMessage("getSourceSyncJob should not be called"),
        },
      })
    )

    expect(result.status).toBe("failed")
    expect(result.failedSourceCount).toBe(1)
    expect(result.items).toMatchObject([
      {
        processingJobId: null,
        status: "failed",
        message: "Failed to enqueue source sync job.",
      },
    ])
  })

  it("gets a run with aggregate counters and item summaries", async () => {
    const completedRun = makeRun({
      requestedSourceCount: 1,
      status: "completed",
      completedSourceCount: 1,
    })
    const completedItem = makeItem({
      source: coinbaseSource,
      jobId: "job-source-1",
      status: "completed",
    })

    const layer = makeLayer({
      listedSources: [coinbaseSource],
      sourceSyncService: {
        startSourceSyncJob: () => Effect.dieMessage("startSourceSyncJob should not be called"),
        replaySourceSyncJob: () => Effect.dieMessage("replaySourceSyncJob should not be called"),
        getSourceSyncJob: () => Effect.dieMessage("getSourceSyncJob should not be called"),
      },
      repositoryOverrides: {
        getVisibleRun: () => Effect.succeed(Option.some(completedRun)),
        refreshRunStatus: () => Effect.succeed(completedRun),
        listRunItems: () => Effect.succeed([completedItem]),
      },
    })

    const result: SourceSyncRunDetails = await Effect.runPromise(
      Effect.flatMap(SourceSyncRunService, (service) =>
        service.getSyncRun({ userId: "user-1", runId: "run-1" })
      ).pipe(Effect.provide(layer))
    )

    expect(result.status).toBe("completed")
    expect(result.completedSourceCount).toBe(1)
    expect(result.items).toEqual([completedItem])
  })
})
