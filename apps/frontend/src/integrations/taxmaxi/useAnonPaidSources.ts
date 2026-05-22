import type { WalletSession } from "@solana/client"
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type Query,
} from "@tanstack/react-query"
import { useCallback, useMemo } from "react"
import { TaxMaxiError, type AnonSourceSyncJob } from "taxmaxi"
import { createAnonSessionSiwxProof } from "./siwx"
import { useTaxMaxiBrowserClient } from "./useTaxMaxi"

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong. Try again."

const isUnauthorizedError = (error: unknown): boolean =>
  error instanceof TaxMaxiError && error.status === 401

const latestJob = (jobs: readonly AnonSourceSyncJob[]): AnonSourceSyncJob | null => jobs[0] ?? null

const hasActiveJob = (jobs: readonly AnonSourceSyncJob[]): boolean => {
  const job = latestJob(jobs)
  return job?.status === "queued" || job?.status === "running"
}

const anonSourcesQueryKey = ["taxmaxi", "anon", "sources"] as const

const anonSourceJobsQueryKey = (sourceId: string) =>
  ["taxmaxi", "anon", "sources", sourceId, "jobs"] as const

const isBrowser = typeof window !== "undefined"

type AnonSourceJobsResponse = {
  readonly jobs: ReadonlyArray<AnonSourceSyncJob>
}

const getJobRefetchInterval = (
  query: Query<
    AnonSourceJobsResponse,
    Error,
    AnonSourceJobsResponse,
    ReturnType<typeof anonSourceJobsQueryKey>
  >
): number | false => (hasActiveJob(query.state.data?.jobs ?? []) ? 4_000 : false)

export type AnonPaidSourceLoadResult = {
  readonly sourceCount: number
}

export const useAnonPaidSources = ({ wallet }: { readonly wallet: WalletSession | undefined }) => {
  const queryClient = useQueryClient()
  const taxMaxiBrowserClient = useTaxMaxiBrowserClient()

  const clearSession = useCallback(
    async () => taxMaxiBrowserClient.anon.session.delete().catch(() => undefined),
    [taxMaxiBrowserClient]
  )

  const listWithOptionalRestore = useCallback(
    async ({ restoreWithWallet }: { readonly restoreWithWallet: boolean }) => {
      try {
        return await taxMaxiBrowserClient.anon.sources.list()
      } catch (caught) {
        if (!isUnauthorizedError(caught)) {
          throw caught
        }

        await clearSession()
      }

      if (!restoreWithWallet) {
        return { sources: [] }
      }

      if (wallet === undefined) {
        throw new Error("Connect the payer wallet first.")
      }

      const challenge = await taxMaxiBrowserClient.anon.session.challenge()
      const siwxProof = await createAnonSessionSiwxProof({
        nonce: challenge.nonce,
        wallet,
      })
      await taxMaxiBrowserClient.anon.session.create({ siwxProof })
      return taxMaxiBrowserClient.anon.sources.list()
    },
    [clearSession, taxMaxiBrowserClient, wallet]
  )

  const sourcesQuery = useQuery({
    queryKey: anonSourcesQueryKey,
    queryFn: () => listWithOptionalRestore({ restoreWithWallet: false }),
    enabled: isBrowser,
  })

  const restoreSources = useMutation({
    mutationFn: () => listWithOptionalRestore({ restoreWithWallet: true }),
    onSuccess: (response) => {
      queryClient.setQueryData(anonSourcesQueryKey, response)
    },
  })

  const sources = sourcesQuery.data?.sources ?? []

  const jobQueries = useQueries({
    queries: sources.map((source) => ({
      queryKey: anonSourceJobsQueryKey(source.sourceId),
      queryFn: () => taxMaxiBrowserClient.anon.sources.listJobs({ sourceId: source.sourceId }),
      enabled: isBrowser,
      refetchInterval: getJobRefetchInterval,
    })),
  })

  const sourceJobsById = useMemo<Readonly<Record<string, readonly AnonSourceSyncJob[]>>>(() => {
    const jobsById: Record<string, readonly AnonSourceSyncJob[]> = {}

    for (const [index, source] of sources.entries()) {
      jobsById[source.sourceId] = jobQueries[index]?.data?.jobs ?? []
    }

    return jobsById
  }, [jobQueries, sources])

  const load = useCallback(
    async ({
      restoreWithWallet,
    }: {
      readonly restoreWithWallet: boolean
      readonly showLoading: boolean
    }): Promise<AnonPaidSourceLoadResult> => {
      try {
        const response = restoreWithWallet
          ? await restoreSources.mutateAsync()
          : await queryClient.fetchQuery({
              queryKey: anonSourcesQueryKey,
              queryFn: () => listWithOptionalRestore({ restoreWithWallet: false }),
            })

        await Promise.all(
          response.sources.map((source) =>
            queryClient.fetchQuery({
              queryKey: anonSourceJobsQueryKey(source.sourceId),
              queryFn: () =>
                taxMaxiBrowserClient.anon.sources.listJobs({ sourceId: source.sourceId }),
            })
          )
        )

        return { sourceCount: response.sources.length }
      } catch {
        return { sourceCount: 0 }
      }
    },
    [listWithOptionalRestore, queryClient, restoreSources, taxMaxiBrowserClient]
  )

  const error =
    restoreSources.error ??
    sourcesQuery.error ??
    jobQueries.find((query) => query.error !== null)?.error ??
    null

  return {
    error: error === null ? null : getErrorMessage(error),
    isLoadingJobs: jobQueries.some((query) => query.isPending),
    isLoadingSources: sourcesQuery.isPending || restoreSources.isPending,
    load,
    sourceJobsById,
    sources,
  }
}
