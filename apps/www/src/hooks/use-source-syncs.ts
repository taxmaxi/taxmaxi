import { useCallback, useEffect, useMemo, useState } from "react"
import type { SourceSyncJob, SourceSyncJobInput, SourceSyncStart } from "taxmaxi"

import {
  getSourceSyncDisplayProgress,
  type SourceSyncIslandItem,
  type SourceSyncStatus,
} from "#/components/source-sync-island"
import type { Account, AccountId } from "#/lib/dashboard-types"

type ActiveSourceSync = SourceSyncIslandItem & {
  sourceId: AccountId
  jobId?: string
}

type UseSourceSyncsOptions = {
  accountsById: ReadonlyMap<AccountId, Account>
  getSourceSyncJob?: (input: SourceSyncJobInput) => Promise<SourceSyncJob>
  startSourceSync?: (sourceId: AccountId) => Promise<SourceSyncStart>
}

const SOURCE_SYNC_POLL_INTERVAL_MS = 500

export function useSourceSyncs({
  accountsById,
  getSourceSyncJob,
  startSourceSync,
}: UseSourceSyncsOptions) {
  const [activeSyncs, setActiveSyncs] = useState<ReadonlyArray<ActiveSourceSync>>([])
  const syncingSourceIds = useMemo(
    () =>
      new Set(
        activeSyncs
          .filter((sync) => sync.status === "queued" || sync.status === "running")
          .map((sync) => sync.sourceId)
      ),
    [activeSyncs]
  )

  const onSourceSync = useCallback(
    (source: Account) => {
      if (!startSourceSync || syncingSourceIds.has(source.id)) {
        return
      }

      setActiveSyncs((syncs) => upsertSourceSync(syncs, makePendingSourceSync(source)))

      startSourceSync(source.id).then(
        (started) => {
          setActiveSyncs((syncs) =>
            upsertSourceSync(syncs, {
              id: source.id,
              jobId: started.jobId,
              progress: getProgressForStatus(started.status),
              sourceId: source.id,
              sourceName: source.name,
              status: started.status,
              ...(started.message === null ? {} : { message: started.message }),
            })
          )
        },
        (error: unknown) => {
          setActiveSyncs((syncs) =>
            upsertSourceSync(syncs, {
              id: source.id,
              progress: 100,
              sourceId: source.id,
              sourceName: source.name,
              status: "failed",
              message: getErrorMessage(error),
            })
          )
        }
      )
    },
    [startSourceSync, syncingSourceIds]
  )

  useEffect(() => {
    if (!getSourceSyncJob) {
      return
    }

    const pollableSyncs = activeSyncs.filter(
      (sync) => sync.jobId !== undefined && (sync.status === "queued" || sync.status === "running")
    )

    if (pollableSyncs.length === 0) {
      return
    }

    const intervalId = window.setInterval(() => {
      for (const sync of pollableSyncs) {
        if (sync.jobId === undefined) {
          continue
        }

        void getSourceSyncJob({ sourceId: sync.sourceId, jobId: sync.jobId }).then(
          (job) =>
            setActiveSyncs((syncs) => upsertSourceSync(syncs, toActiveSourceSync(job, sync))),
          () => undefined
        )
      }
    }, SOURCE_SYNC_POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [activeSyncs, getSourceSyncJob])

  useEffect(() => {
    const terminalSyncs = activeSyncs.filter((sync) => sync.status === "completed")

    if (terminalSyncs.length === 0) {
      return
    }

    const timeoutIds = terminalSyncs.map((sync) =>
      window.setTimeout(() => {
        setActiveSyncs((syncs) => syncs.filter((candidate) => candidate.id !== sync.id))
      }, 2800)
    )

    return () => {
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [activeSyncs])

  const onDismissSync = useCallback((item: SourceSyncIslandItem) => {
    setActiveSyncs((syncs) => syncs.filter((sync) => sync.id !== item.id))
  }, [])

  const onRetrySync = useCallback(
    (item: SourceSyncIslandItem) => {
      const source = accountsById.get(item.id)

      if (!source) {
        return
      }

      setActiveSyncs((syncs) => syncs.filter((sync) => sync.id !== item.id))
      onSourceSync(source)
    },
    [accountsById, onSourceSync]
  )

  return {
    activeSyncs,
    onDismissSync,
    onRetrySync,
    onSourceSync,
    syncingSourceIds,
  }
}

function makePendingSourceSync(source: Account): ActiveSourceSync {
  return {
    id: source.id,
    progress: 0,
    sourceId: source.id,
    sourceName: source.name,
    status: "queued",
  }
}

function toActiveSourceSync(job: SourceSyncJob, current: ActiveSourceSync): ActiveSourceSync {
  return {
    ...current,
    id: job.sourceId,
    jobId: job.jobId,
    progress: getSourceSyncDisplayProgress({
      phase: job.phase,
      progressPercent: job.progressPercent,
      status: job.status,
    }),
    sourceId: job.sourceId,
    status: job.status,
    ...(job.phase === null ? {} : { phase: job.phase }),
    ...(job.processedRecords === null ? {} : { processedRecords: job.processedRecords }),
    ...(job.totalRecords === null ? {} : { totalRecords: job.totalRecords }),
    ...(job.importedRecords === null ? {} : { importedRecords: job.importedRecords }),
    ...(job.normalizedRecords === null ? {} : { normalizedRecords: job.normalizedRecords }),
    ...(job.failedRecords === null ? {} : { failedRecords: job.failedRecords }),
    ...(job.message === null ? {} : { message: job.message }),
  }
}

function upsertSourceSync(
  syncs: ReadonlyArray<ActiveSourceSync>,
  nextSync: ActiveSourceSync
): ReadonlyArray<ActiveSourceSync> {
  const found = syncs.some((sync) => sync.id === nextSync.id)

  if (!found) {
    return [nextSync, ...syncs]
  }

  return syncs.map((sync) => (sync.id === nextSync.id ? nextSync : sync))
}

function getProgressForStatus(status: SourceSyncStatus): number {
  switch (status) {
    case "queued":
    case "running":
      return 0
    case "completed":
    case "failed":
      return 100
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to start sync."
}
