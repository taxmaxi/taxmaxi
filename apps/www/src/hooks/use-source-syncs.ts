import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"
import {
  TaxMaxiError,
  isTaxMaxiUnauthorizedError,
  type SourceSyncJob,
  type SourceSyncJobInput,
  type SourceSyncStart,
} from "taxmaxi"

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
  onCompleted?: (sourceId: AccountId) => void | Promise<void>
  onUnauthorized?: () => void | Promise<void>
  startSourceSync?: (sourceId: AccountId) => Promise<SourceSyncStart>
}

const SOURCE_SYNC_POLL_INTERVAL_MS = 500
const COMPLETED_SYNC_DISMISS_DELAY_MS = 2800
const MAX_CONSECUTIVE_POLL_FAILURES = 3

export function useSourceSyncs({
  accountsById,
  getSourceSyncJob,
  onCompleted,
  onUnauthorized,
  startSourceSync,
}: UseSourceSyncsOptions) {
  const [activeSyncs, setActiveSyncs] = useState<ReadonlyArray<ActiveSourceSync>>([])
  const completionTimeoutsRef = useRef(new Map<string, number>())
  const completedNotificationsRef = useRef(new Set<string>())
  const pollFailureCountsRef = useRef(new Map<string, number>())
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
    async (source: Account) => {
      if (!startSourceSync || syncingSourceIds.has(source.id)) {
        return
      }

      setActiveSyncs((syncs) => upsertSourceSync(syncs, makePendingSourceSync(source)))

      try {
        const started = await startSourceSync(source.id)
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
      } catch (error: unknown) {
        if (isTaxMaxiUnauthorizedError(error)) {
          setActiveSyncs((syncs) => syncs.filter((sync) => sync.sourceId !== source.id))
          try {
            await onUnauthorized?.()
          } catch {
            setActiveSyncs((syncs) =>
              upsertSourceSync(syncs, {
                id: source.id,
                progress: 100,
                sourceId: source.id,
                sourceName: source.name,
                status: "failed",
                message: "Your session expired. Reload the page to sign in again.",
              })
            )
          }
          return
        }

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
    },
    [onUnauthorized, startSourceSync, syncingSourceIds]
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
        const jobId = sync.jobId

        void getSourceSyncJob({ sourceId: sync.sourceId, jobId }).then(
          (job) => {
            const syncKey = getSourceSyncKey(sync)
            pollFailureCountsRef.current.delete(syncKey)
            if (job.status === "completed" && !completedNotificationsRef.current.has(syncKey)) {
              completedNotificationsRef.current.add(syncKey)
              void notifySourceSyncCompleted({
                completedNotifications: completedNotificationsRef.current,
                onCompleted,
                sourceId: sync.sourceId,
                syncKey,
              })
            }
            setActiveSyncs((syncs) => {
              const currentSync = syncs.find((candidate) => candidate.id === sync.id)

              if (
                !currentSync ||
                currentSync.jobId !== jobId ||
                currentSync.status === "completed" ||
                currentSync.status === "failed"
              ) {
                return syncs
              }

              return replaceSourceSync(syncs, toActiveSourceSync(job, currentSync))
            })
          },
          (error: unknown) => {
            const syncKey = getSourceSyncKey(sync)

            if (isTaxMaxiUnauthorizedError(error)) {
              pollFailureCountsRef.current.delete(syncKey)
              failPolledSourceSync({
                expectedJobId: jobId,
                message: "Your session expired. Sign in again to continue syncing.",
                setActiveSyncs,
                sourceId: sync.sourceId,
              })
              void handlePollingUnauthorized({ onUnauthorized })
              return
            }

            const failureCount = (pollFailureCountsRef.current.get(syncKey) ?? 0) + 1
            const jobNotFound = error instanceof TaxMaxiError && error.status === 404

            if (!jobNotFound && failureCount < MAX_CONSECUTIVE_POLL_FAILURES) {
              pollFailureCountsRef.current.set(syncKey, failureCount)
              return
            }

            pollFailureCountsRef.current.delete(syncKey)
            failPolledSourceSync({
              expectedJobId: jobId,
              message: jobNotFound
                ? "The sync job could not be found. Start the sync again."
                : "The sync status could not be loaded after several attempts. Try again.",
              setActiveSyncs,
              sourceId: sync.sourceId,
            })
          }
        )
      }
    }, SOURCE_SYNC_POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [activeSyncs, getSourceSyncJob, onCompleted, onUnauthorized])

  useEffect(() => {
    const completedSyncKeys = new Set<string>()

    for (const sync of activeSyncs) {
      if (sync.status !== "completed") {
        continue
      }

      const syncKey = getSourceSyncKey(sync)
      completedSyncKeys.add(syncKey)

      if (completionTimeoutsRef.current.has(syncKey)) {
        continue
      }

      const timeoutId = window.setTimeout(() => {
        completionTimeoutsRef.current.delete(syncKey)
        setActiveSyncs((syncs) =>
          syncs.filter((candidate) => getSourceSyncKey(candidate) !== syncKey)
        )
      }, COMPLETED_SYNC_DISMISS_DELAY_MS)

      completionTimeoutsRef.current.set(syncKey, timeoutId)
    }

    for (const [syncKey, timeoutId] of completionTimeoutsRef.current) {
      if (completedSyncKeys.has(syncKey)) {
        continue
      }

      window.clearTimeout(timeoutId)
      completionTimeoutsRef.current.delete(syncKey)
    }

    const activeSyncKeys = new Set(activeSyncs.map(getSourceSyncKey))
    for (const syncKey of pollFailureCountsRef.current.keys()) {
      if (!activeSyncKeys.has(syncKey)) {
        pollFailureCountsRef.current.delete(syncKey)
      }
    }
  }, [activeSyncs])

  useEffect(
    () => () => {
      for (const timeoutId of completionTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId)
      }

      completionTimeoutsRef.current.clear()
      completedNotificationsRef.current.clear()
      pollFailureCountsRef.current.clear()
    },
    []
  )

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
      void onSourceSync(source)
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
    ...(job.fetchedRecords === null ? {} : { fetchedRecords: job.fetchedRecords }),
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

function replaceSourceSync(
  syncs: ReadonlyArray<ActiveSourceSync>,
  nextSync: ActiveSourceSync
): ReadonlyArray<ActiveSourceSync> {
  return syncs.map((sync) => (sync.id === nextSync.id ? nextSync : sync))
}

function getSourceSyncKey(sync: ActiveSourceSync): string {
  return `${sync.sourceId}:${sync.jobId ?? "pending"}`
}

function failPolledSourceSync({
  expectedJobId,
  message,
  setActiveSyncs,
  sourceId,
}: {
  expectedJobId: string
  message: string
  setActiveSyncs: Dispatch<SetStateAction<ReadonlyArray<ActiveSourceSync>>>
  sourceId: AccountId
}) {
  setActiveSyncs((syncs) =>
    syncs.map((sync) =>
      sync.sourceId === sourceId &&
      sync.jobId === expectedJobId &&
      (sync.status === "queued" || sync.status === "running")
        ? { ...sync, message, progress: 100, status: "failed" }
        : sync
    )
  )
}

async function notifySourceSyncCompleted({
  completedNotifications,
  onCompleted,
  sourceId,
  syncKey,
}: {
  completedNotifications: Set<string>
  onCompleted: ((sourceId: AccountId) => void | Promise<void>) | undefined
  sourceId: AccountId
  syncKey: string
}) {
  try {
    await onCompleted?.(sourceId)
  } catch {
    completedNotifications.delete(syncKey)
  }
}

async function handlePollingUnauthorized({
  onUnauthorized,
}: {
  onUnauthorized: (() => void | Promise<void>) | undefined
}) {
  try {
    await onUnauthorized?.()
  } catch {
    // The sync is already failed and dismissible; a later protected request will retry auth cleanup.
  }
}

function getProgressForStatus(status: SourceSyncStatus): number {
  switch (status) {
    case "queued":
    case "running":
      return 0
    case "completed":
    case "failed":
    case "credit_required":
      return 100
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to start sync."
}
