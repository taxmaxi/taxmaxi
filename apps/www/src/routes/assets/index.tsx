import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"

import { AssetCatalog } from "#/components/asset-catalog"
import {
  DEFAULT_TAXMAXI_ASSET_LIMIT,
  DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT,
  queries,
} from "#/integrations/taxmaxi/queries"
import { seo } from "#/lib/seo"

const assetListInput = { limit: DEFAULT_TAXMAXI_ASSET_LIMIT }
const pendingAssetListInput = { limit: DEFAULT_TAXMAXI_PENDING_ASSET_LIMIT }

export const Route = createFileRoute("/assets/")({
  loader: async ({ context }) => {
    const taxmaxi = context.taxmaxi()
    return Promise.all([
      context.queryClient.ensureQueryData(queries.assetList(taxmaxi, assetListInput)),
      context.queryClient.ensureQueryData(queries.pendingAssetList(taxmaxi, pendingAssetListInput)),
    ])
  },
  head: () => ({
    meta: seo({
      title: "Asset catalog | TaxMaxi",
      description: "Browse TaxMaxi's public canonical asset catalog.",
    }),
  }),
  component: AssetsIndexRoute,
})

function AssetsIndexRoute() {
  const { taxmaxi } = Route.useRouteContext()
  const navigate = Route.useNavigate()
  const {
    data: { assets },
  } = useSuspenseQuery(queries.assetList(taxmaxi(), assetListInput))
  const {
    data: { pendingAssets },
  } = useSuspenseQuery(queries.pendingAssetList(taxmaxi(), pendingAssetListInput))

  return (
    <AssetCatalog
      assets={assets}
      onClose={() => {
        void navigate({ to: "/app" })
      }}
      pendingAssets={pendingAssets}
    />
  )
}
