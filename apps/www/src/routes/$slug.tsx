import { createFileRoute, notFound } from "@tanstack/react-router"

import { CmsContentPage } from "#/components/cms-content-page"
import { CMS_ROUTE_STALE_TIME_MS, toPayloadLocale } from "#/integrations/payload/content"
import { getLandingPage } from "#/integrations/payload/functions"
import { createCmsPageHead } from "#/integrations/payload/head"
import { getLocale } from "#/paraglide/runtime"

export const Route = createFileRoute("/$slug")({
  staleTime: CMS_ROUTE_STALE_TIME_MS,
  preloadStaleTime: CMS_ROUTE_STALE_TIME_MS,
  loader: async ({ params }) => {
    const page = await getLandingPage({
      data: { locale: toPayloadLocale(getLocale()), slug: params.slug },
    })
    if (!page) throw notFound()
    return page
  },
  head: ({ loaderData }) =>
    loaderData ? createCmsPageHead(loaderData) : { meta: [{ name: "robots", content: "noindex" }] },
  component: LandingContentRoute,
})

function LandingContentRoute() {
  return <CmsContentPage page={Route.useLoaderData()} />
}
