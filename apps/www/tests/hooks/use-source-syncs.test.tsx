// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SourceSyncJob } from "taxmaxi"

import { useSourceSyncs } from "#/hooks/use-source-syncs"

const source = {
  id: "source-1",
  name: "Test source",
  kind: "wallet" as const,
  importedTransactions: 0,
  unresolvedItems: 0,
  lastSync: "Never",
}

const makeJob = (status: SourceSyncJob["status"]): SourceSyncJob => ({
  sourceId: source.id,
  jobId: "job-1",
  status,
  phase: status === "completed" ? "completed" : "classifying",
  processedRecords: null,
  totalRecords: null,
  progressPercent: status === "completed" ? 100 : 50,
  importedRecords: null,
  normalizedRecords: null,
  failedRecords: null,
  message: null,
})

const deferred = <A,>() => {
  let resolvePromise: (value: A) => void = () => undefined
  const promise = new Promise<A>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe("useSourceSyncs", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not let an older running response overwrite a completed sync", async () => {
    vi.useFakeTimers()
    const firstPoll = deferred<SourceSyncJob>()
    const secondPoll = deferred<SourceSyncJob>()
    const getSourceSyncJob = vi
      .fn<() => Promise<SourceSyncJob>>()
      .mockReturnValueOnce(firstPoll.promise)
      .mockReturnValueOnce(secondPoll.promise)

    const { result } = renderHook(() =>
      useSourceSyncs({
        accountsById: new Map([[source.id, source]]),
        getSourceSyncJob,
        startSourceSync: async () => ({
          sourceId: source.id,
          jobId: "job-1",
          status: "queued",
          message: null,
        }),
      })
    )

    await act(async () => {
      await result.current.onSourceSync(source)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    await act(async () => {
      secondPoll.resolve(makeJob("completed"))
      await Promise.resolve()
    })
    expect(result.current.activeSyncs[0]?.status).toBe("completed")

    await act(async () => {
      firstPoll.resolve(makeJob("running"))
      await Promise.resolve()
    })
    expect(result.current.activeSyncs[0]?.status).toBe("completed")
  })
})
