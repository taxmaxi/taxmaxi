import { useInfiniteQuery } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useCallback, useMemo } from "react"
import { isTaxMaxiUnauthorizedError, type TaxMaxi } from "taxmaxi"

import { AssetCatalog, type AssetCatalogFeeds } from "#/components/asset-catalog"
import {
  assetListInput,
  pendingAssetListInput,
  useAssetCatalogFeeds,
} from "#/hooks/use-asset-catalog-feeds"
import { queries } from "#/integrations/taxmaxi/queries"
import {
  closeAssetCatalog,
  loadAssetCatalogFeeds,
  loadAssetExceptionFeed,
} from "#/lib/asset-catalog-route"
import { seo } from "#/lib/seo"
import { m } from "#/paraglide/messages"

const assetExceptionListInput = { limit: 40 }

/** Shared by the public /assets page and the in-app /app/assets overlay. */
export const assetCatalogLoader = ({
  abortController,
  context,
}: {
  readonly abortController: AbortController
  readonly context: {
    readonly queryClient: QueryClient
    readonly taxmaxi: () => TaxMaxi
  }
}) => {
  const taxmaxi = context.taxmaxi()
  const approvedQuery = queries.assetList(taxmaxi, assetListInput)
  const pendingQuery = queries.pendingAssetList(taxmaxi, pendingAssetListInput)

  return loadAssetCatalogFeeds({
    cancelApproved: () =>
      context.queryClient.cancelQueries({ exact: true, queryKey: approvedQuery.queryKey }),
    cancelPending: () =>
      context.queryClient.cancelQueries({ exact: true, queryKey: pendingQuery.queryKey }),
    loadApproved: () => context.queryClient.ensureInfiniteQueryData(approvedQuery),
    loadPending: () => context.queryClient.ensureInfiniteQueryData(pendingQuery),
    signal: abortController.signal,
  })
}

export const Route = createFileRoute("/assets/")({
  loader: async ({ abortController, context }) => {
    const taxmaxi = context.taxmaxi()
    assetCatalogLoader({ abortController, context })

    const account = await taxmaxi.auth.account().catch((error: unknown) => {
      if (isTaxMaxiUnauthorizedError(error)) {
        return null
      }
      throw error
    })
    const isAdmin = account?.account.role === "admin"
    if (isAdmin) {
      loadAssetExceptionFeed(() =>
        context.queryClient.ensureInfiniteQueryData(
          queries.assetExceptionList(taxmaxi, assetExceptionListInput)
        )
      )
    }

    return { isAdmin }
  },
  head: () => ({
    meta: seo({
      title: m["assetCatalog.seoTitle"](),
      description: m["assetCatalog.seoDescription"](),
    }),
  }),
  component: AssetsIndexRoute,
})

function AssetsIndexRoute() {
  const { taxmaxi } = Route.useRouteContext()
  const { isAdmin } = Route.useLoaderData()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const { debouncedCatalogQuery, feeds: baseFeeds, onQueryChange } = useAssetCatalogFeeds(taxmaxi())

  const searchedExceptionListInput = useMemo(
    () => ({
      ...assetExceptionListInput,
      ...(debouncedCatalogQuery.length > 0 ? { query: debouncedCatalogQuery } : {}),
    }),
    [debouncedCatalogQuery]
  )

  const assetExceptionQuery = useInfiniteQuery({
    ...queries.assetExceptionList(taxmaxi(), searchedExceptionListInput),
    enabled: isAdmin,
  })

  const assetExceptionPages = assetExceptionQuery.data?.pages
  const assetExceptions = useMemo(
    () => assetExceptionPages?.flatMap((page) => page.exceptions) ?? [],
    [assetExceptionPages]
  )

  const feeds = useMemo<AssetCatalogFeeds>(
    () =>
      isAdmin
        ? {
            ...baseFeeds,
            exceptions: {
              canLoadMore: assetExceptionQuery.hasNextPage,
              isLoading: assetExceptionQuery.isFetching,
              items: assetExceptions,
              loadMore: assetExceptionQuery.fetchNextPage,
              retry: assetExceptionQuery.refetch,
              unavailable: assetExceptionQuery.isError || assetExceptionQuery.isFetchNextPageError,
            },
          }
        : baseFeeds,
    [
      assetExceptionQuery.fetchNextPage,
      assetExceptionQuery.hasNextPage,
      assetExceptionQuery.isError,
      assetExceptionQuery.isFetchNextPageError,
      assetExceptionQuery.isFetching,
      assetExceptionQuery.refetch,
      assetExceptions,
      baseFeeds,
      isAdmin,
    ]
  )

  const closeCatalog = useCallback(() => {
    closeAssetCatalog({
      history: router.history,
      navigateToFallback: (navigation) => {
        void navigate(navigation)
      },
    })
  }, [navigate, router.history])

  const exceptionActions = useMemo(
    () =>
      isAdmin
        ? {
            get: (id: string) => taxmaxi().assets.getException({ id }),
            lookup: (
              input: Parameters<ReturnType<typeof taxmaxi>["assets"]["lookupException"]>[0]
            ) => taxmaxi().assets.lookupException(input),
            preview: (
              input: Parameters<ReturnType<typeof taxmaxi>["assets"]["previewExceptionDecision"]>[0]
            ) => taxmaxi().assets.previewExceptionDecision(input),
            submit: async (
              input: Parameters<ReturnType<typeof taxmaxi>["assets"]["submitExceptionDecision"]>[0]
            ) => {
              const detail = await taxmaxi().assets.submitExceptionDecision(input)
              void assetExceptionQuery.refetch()
              return detail
            },
          }
        : undefined,
    [assetExceptionQuery.refetch, isAdmin, taxmaxi]
  )

  return (
    <AssetCatalog
      exceptionActions={exceptionActions}
      feeds={feeds}
      onClose={closeCatalog}
      onQueryChange={onQueryChange}
    />
  )
}
