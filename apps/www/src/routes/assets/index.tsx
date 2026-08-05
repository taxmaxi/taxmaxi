import { Link, createFileRoute } from "@tanstack/react-router"
import { useSuspenseQuery } from "@tanstack/react-query"
import { ArrowUpRight, Search } from "lucide-react"
import { useMemo, useState } from "react"

import { AssetsPageShell } from "#/components/assets-page-shell"
import { SectionHeader } from "#/components/section-header"
import { Button } from "#/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card"
import {
  describeTaxMaxiAsset,
  filterTaxMaxiAssets,
  formatAssetType,
  type TaxMaxiAsset,
} from "#/lib/assets"
import { DEFAULT_TAXMAXI_ASSET_LIMIT, queries } from "#/integrations/taxmaxi/queries"
import { seo } from "#/lib/seo"

const assetListInput = { limit: DEFAULT_TAXMAXI_ASSET_LIMIT }

export const Route = createFileRoute("/assets/")({
  loader: async ({ context }) => {
    const taxmaxi = context.taxmaxi()
    return context.queryClient.ensureQueryData(queries.assetList(taxmaxi, assetListInput))
  },
  head: () => ({
    meta: seo({
      title: "Assets | TaxMaxi",
      description: "Canonical crypto assets supported by TaxMaxi normalization.",
    }),
  }),
  component: AssetsIndexRoute,
})

function AssetsIndexRoute() {
  const { taxmaxi } = Route.useRouteContext()
  const {
    data: { assets },
  } = useSuspenseQuery(queries.assetList(taxmaxi(), assetListInput))
  const [query, setQuery] = useState("")
  const filteredAssets = useMemo(() => filterTaxMaxiAssets({ assets, query }), [assets, query])
  const networkCount = useMemo(
    () =>
      new Set(
        assets.flatMap((asset) =>
          asset.representations.map((representation) => representation.blockchainId)
        )
      ).size,
    [assets]
  )
  const contractCount = useMemo(
    () =>
      assets.reduce(
        (count, asset) =>
          count +
          asset.representations.filter(
            (representation) =>
              representation.contractAddress !== null || representation.mintAddress !== null
          ).length,
        0
      ),
    [assets]
  )

  return (
    <AssetsPageShell>
      <div className="flex flex-col gap-10">
        <SectionHeader
          accent={true}
          description="Canonical assets used by TaxMaxi to normalize wallets, exchanges, transfers, swaps, and tax reports."
          descriptionSize="lead"
          eyebrow="Asset registry"
          heading="Supported assets"
          titleAs="h1"
          titleSize="hero"
          tone="brand"
        />

        <div className="grid gap-4 md:grid-cols-3">
          <AssetStatCard label="Canonical assets" value={assets.length.toString()} />
          <AssetStatCard label="Networks" value={networkCount.toString()} />
          <AssetStatCard label="Contracts and mints" value={contractCount.toString()} />
        </div>

        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault()
          }}
          role="search"
        >
          <label className="sr-only" htmlFor="asset-search">
            Search assets
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-marketing-muted"
          />
          <input
            autoComplete="off"
            className="h-14 w-full rounded-[1.25rem] border border-marketing-border-muted bg-marketing-surface py-0 pl-12 pr-4 text-base text-marketing-foreground outline-none transition-[background-color,border-color,box-shadow] placeholder:text-marketing-muted focus-visible:border-marketing-border focus-visible:ring-3 focus-visible:ring-marketing-border/40"
            id="asset-search"
            onChange={(event) => {
              setQuery(event.currentTarget.value)
            }}
            placeholder="Search by name, symbol, network, or contract"
            spellCheck={false}
            type="search"
            value={query}
          />
        </form>

        <section aria-live="polite" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-sm text-marketing-muted">
              Showing {filteredAssets.length} of {assets.length} assets
            </p>
            {query.trim().length > 0 ? (
              <Button
                className="border-marketing-border-muted bg-marketing-surface text-marketing-foreground hover:bg-marketing-surface-hover"
                onClick={() => {
                  setQuery("")
                }}
                type="button"
                variant="outline"
              >
                Clear search
              </Button>
            ) : null}
          </div>

          {filteredAssets.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-3">
              {filteredAssets.map((asset) => (
                <AssetListCard asset={asset} key={asset.id} />
              ))}
            </div>
          ) : (
            <Card className="border border-marketing-border-muted bg-marketing-surface text-marketing-foreground shadow-none ring-0">
              <CardHeader>
                <CardTitle>No assets found</CardTitle>
                <CardDescription className="text-marketing-muted">
                  Try a symbol like SOL, a network like Solana, or a token contract address.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </section>
      </div>
    </AssetsPageShell>
  )
}

function AssetStatCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <Card
      className="border border-marketing-border-muted bg-marketing-surface text-marketing-foreground shadow-none ring-0"
      size="sm"
    >
      <CardHeader>
        <CardDescription className="text-marketing-muted">{label}</CardDescription>
        <CardTitle className="font-mono text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function AssetListCard({ asset }: { readonly asset: TaxMaxiAsset }) {
  const networkNames = asset.representations.map((representation) => representation.blockchainName)
  const networkLabel =
    networkNames.length === 0
      ? "No network representation"
      : networkNames.slice(0, 2).join(", ") +
        (networkNames.length > 2 ? ` +${networkNames.length - 2}` : "")

  return (
    <Link
      className="group block h-full rounded-[1.75rem] no-underline outline-none focus-visible:ring-3 focus-visible:ring-marketing-border/40"
      params={{ assetId: asset.id }}
      to="/assets/$assetId"
    >
      <Card
        className="h-full rounded-[1.75rem] border border-marketing-border-muted bg-marketing-surface text-marketing-foreground shadow-none ring-0 transition-[background-color,border-color] group-hover:border-marketing-border group-hover:bg-marketing-surface-hover"
        size="sm"
      >
        <CardHeader className="gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <AssetSymbolMark asset={asset} />
              <div className="min-w-0">
                <CardTitle className="truncate text-xl">{asset.symbol}</CardTitle>
                <CardDescription className="truncate text-marketing-muted">
                  {asset.name}
                </CardDescription>
              </div>
            </div>
            <ArrowUpRight
              aria-hidden="true"
              className="mt-1 size-4 shrink-0 text-marketing-muted transition-colors group-hover:text-marketing-foreground"
            />
          </div>
          <CardDescription className="line-clamp-3 text-marketing-muted">
            {describeTaxMaxiAsset(asset)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <AssetMeta label="Networks" value={networkLabel} />
            <AssetMeta label="Type" value={formatAssetType(asset.type)} />
            <AssetMeta label="Representations" value={asset.representations.length.toString()} />
            <AssetMeta label="Economic ID" value={asset.id} />
          </dl>
        </CardContent>
      </Card>
    </Link>
  )
}

function AssetSymbolMark({ asset }: { readonly asset: TaxMaxiAsset }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-marketing-border-muted bg-marketing-surface-active text-sm font-semibold text-marketing-foreground">
      {asset.logoUrl ? (
        <img alt={`${asset.name} logo`} className="size-full object-cover" src={asset.logoUrl} />
      ) : (
        <span aria-hidden="true">{asset.symbol.slice(0, 2)}</span>
      )}
    </div>
  )
}

function AssetMeta({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-[0.16em] text-marketing-muted">{label}</dt>
      <dd className="mt-1 truncate text-marketing-foreground">{value}</dd>
    </div>
  )
}
