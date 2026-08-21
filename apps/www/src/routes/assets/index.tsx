import { useInfiniteQuery } from "@tanstack/react-query"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useCallback, useMemo, useState } from "react"

import { AssetCatalog, type AssetCatalogFeeds } from "#/components/asset-catalog"
import {
  DEFAULT_TAXMAXI_ASSET_LIMIT,
  DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT,
  queries,
} from "#/integrations/taxmaxi/queries"
import {
  closeAssetCatalog,
  loadAssetCatalogFeeds,
  retryAssetCatalogFeed,
  useDebouncedCatalogQuery,
} from "#/lib/asset-catalog-route"
import { seo } from "#/lib/seo"
import { m } from "#/paraglide/messages"

const assetListInput = { limit: DEFAULT_TAXMAXI_ASSET_LIMIT }
const pendingAssetListInput = { limit: DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT }
const assetExceptionListInput = { limit: 40 }

export const Route = createFileRoute("/assets/")({
  loader: async ({ abortController, context }) => {
    const taxmaxi = context.taxmaxi()
    const approvedQuery = queries.assetList(taxmaxi, assetListInput)
    const pendingQuery = queries.pendingAssetList(taxmaxi, pendingAssetListInput)

    const account = await taxmaxi.auth.account().catch(() => null)
    const isAdmin = account?.account.role === "admin"
    if (isAdmin) {
      void context.queryClient.ensureInfiniteQueryData(
        queries.assetExceptionList(taxmaxi, assetExceptionListInput)
      )
    }

    loadAssetCatalogFeeds({
      cancelApproved: () =>
        context.queryClient.cancelQueries({ exact: true, queryKey: approvedQuery.queryKey }),
      cancelPending: () =>
        context.queryClient.cancelQueries({ exact: true, queryKey: pendingQuery.queryKey }),
      loadApproved: () => context.queryClient.ensureInfiniteQueryData(approvedQuery),
      loadPending: () => context.queryClient.ensureInfiniteQueryData(pendingQuery),
      signal: abortController.signal,
    })

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
  const [catalogQuery, setCatalogQuery] = useState("")
  const debouncedCatalogQuery = useDebouncedCatalogQuery(catalogQuery.trim())

  const searchedAssetListInput = useMemo(
    () => ({
      ...assetListInput,
      ...(debouncedCatalogQuery.length > 0 ? { query: debouncedCatalogQuery } : {}),
    }),
    [debouncedCatalogQuery]
  )

  const searchedPendingAssetListInput = useMemo(
    () => ({
      ...pendingAssetListInput,
      ...(debouncedCatalogQuery.length > 0 ? { query: debouncedCatalogQuery } : {}),
    }),
    [debouncedCatalogQuery]
  )

  const assetQuery = useInfiniteQuery(queries.assetList(taxmaxi(), searchedAssetListInput))

  const pendingAssetQuery = useInfiniteQuery(
    queries.pendingAssetList(taxmaxi(), searchedPendingAssetListInput)
  )
  const assetExceptionQuery = useInfiniteQuery({
    ...queries.assetExceptionList(taxmaxi(), assetExceptionListInput),
    enabled: isAdmin,
  })

  const assetPages = assetQuery.data?.pages
  const pendingAssetPages = pendingAssetQuery.data?.pages
  const assetExceptionPages = assetExceptionQuery.data?.pages
  const assets = useMemo(() => assetPages?.flatMap((page) => page.assets) ?? [], [assetPages])

  const pendingAssets = useMemo(
    () => pendingAssetPages?.flatMap((page) => page.pendingAssets) ?? [],
    [pendingAssetPages]
  )
  const assetExceptions = useMemo(
    () => assetExceptionPages?.flatMap((page) => page.exceptions) ?? [],
    [assetExceptionPages]
  )

  const retryApproved = useCallback(
    () =>
      retryAssetCatalogFeed({
        fetchNextPage: assetQuery.fetchNextPage,
        isFetchNextPageError: assetQuery.isFetchNextPageError,
        refetch: assetQuery.refetch,
      }),
    [assetQuery.fetchNextPage, assetQuery.isFetchNextPageError, assetQuery.refetch]
  )

  const retryPending = useCallback(
    () =>
      retryAssetCatalogFeed({
        fetchNextPage: pendingAssetQuery.fetchNextPage,
        isFetchNextPageError: pendingAssetQuery.isFetchNextPageError,
        refetch: pendingAssetQuery.refetch,
      }),
    [
      pendingAssetQuery.fetchNextPage,
      pendingAssetQuery.isFetchNextPageError,
      pendingAssetQuery.refetch,
    ]
  )

  const feeds = useMemo<AssetCatalogFeeds>(
    () => ({
      approved: {
        canLoadMore: assetQuery.hasNextPage,
        isLoading: assetQuery.isFetching,
        items: assets,
        loadMore: assetQuery.fetchNextPage,
        retry: retryApproved,
        unavailable: assetQuery.isError || assetQuery.isFetchNextPageError,
      },
      pending: {
        canLoadMore: pendingAssetQuery.hasNextPage,
        isLoading: pendingAssetQuery.isFetching,
        items: pendingAssets,
        loadMore: pendingAssetQuery.fetchNextPage,
        retry: retryPending,
        unavailable: pendingAssetQuery.isError || pendingAssetQuery.isFetchNextPageError,
      },
      ...(isAdmin
        ? {
            exceptions: {
              canLoadMore: assetExceptionQuery.hasNextPage,
              isLoading: assetExceptionQuery.isFetching,
              items: assetExceptions,
              loadMore: assetExceptionQuery.fetchNextPage,
              retry: assetExceptionQuery.refetch,
              unavailable: assetExceptionQuery.isError || assetExceptionQuery.isFetchNextPageError,
            },
          }
        : {}),
    }),
    [
      assetQuery.fetchNextPage,
      assetQuery.hasNextPage,
      assetQuery.isError,
      assetQuery.isFetchNextPageError,
      assetQuery.isFetching,
      assets,
      pendingAssetQuery.fetchNextPage,
      pendingAssetQuery.hasNextPage,
      pendingAssetQuery.isError,
      pendingAssetQuery.isFetchNextPageError,
      pendingAssetQuery.isFetching,
      pendingAssets,
      retryApproved,
      retryPending,
      assetExceptionQuery.fetchNextPage,
      assetExceptionQuery.hasNextPage,
      assetExceptionQuery.isError,
      assetExceptionQuery.isFetchNextPageError,
      assetExceptionQuery.isFetching,
      assetExceptionQuery.refetch,
      assetExceptions,
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
    [isAdmin, taxmaxi]
  )

  return (
    <AssetCatalog
      exceptionActions={exceptionActions}
      feeds={feeds}
      onClose={closeCatalog}
      onQueryChange={setCatalogQuery}
    />
  )
}
