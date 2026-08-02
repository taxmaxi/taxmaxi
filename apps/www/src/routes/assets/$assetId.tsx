import { useSuspenseQuery } from "@tanstack/react-query"
import { Link, createFileRoute, notFound } from "@tanstack/react-router"
import { ArrowLeft, ExternalLink } from "lucide-react"

import { AssetsPageShell } from "#/components/assets-page-shell"
import { LandingButton } from "#/components/landing-button"
import { Button } from "#/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card"
import { Separator } from "#/components/ui/separator"
import {
  describeTaxMaxiAsset,
  formatBlockchainName,
  formatAssetType,
  getAssetRepresentationExplorerHref,
  type TaxMaxiAsset,
} from "#/lib/assets"
import { isTaxMaxiAssetNotFoundError, queries } from "#/integrations/taxmaxi/queries"
import { seo } from "#/lib/seo"

export const Route = createFileRoute("/assets/$assetId")({
  loader: async ({ context, params }) => {
    try {
      const taxmaxi = context.taxmaxi()
      return await context.queryClient.ensureQueryData(queries.assetDetail(taxmaxi, params.assetId))
    } catch (error) {
      if (isTaxMaxiAssetNotFoundError(error)) {
        throw notFound()
      }
      throw error
    }
  },
  head: ({ loaderData }) => ({
    meta: seo({
      title: loaderData
        ? `${loaderData.symbol} (${loaderData.name}) | TaxMaxi Assets`
        : "Asset | TaxMaxi",
      description: loaderData
        ? describeTaxMaxiAsset(loaderData)
        : "Canonical crypto asset supported by TaxMaxi.",
    }),
  }),
  notFoundComponent: AssetNotFoundRoute,
  component: AssetDetailRoute,
})

function AssetDetailRoute() {
  const { assetId } = Route.useParams()
  const { taxmaxi } = Route.useRouteContext()
  const { data: asset } = useSuspenseQuery(queries.assetDetail(taxmaxi(), assetId))

  return (
    <AssetsPageShell>
      <div className="flex flex-col gap-8">
        <Button
          asChild
          className="w-fit border-marketing-border-muted bg-marketing-surface text-marketing-foreground hover:bg-marketing-surface-hover"
          variant="outline"
        >
          <Link to="/assets">
            <ArrowLeft data-icon="inline-start" />
            All assets
          </Link>
        </Button>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="flex flex-col gap-6 rounded-[2rem] border border-marketing-border-muted bg-marketing-surface p-6 text-marketing-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] sm:p-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-center gap-5">
                <AssetSymbolMark asset={asset} />
                <div className="min-w-0">
                  <p className="m-0 text-sm font-medium uppercase tracking-[0.18em] text-marketing-muted">
                    Economic asset
                  </p>
                  <h1 className="mt-2 truncate font-display text-5xl font-semibold leading-none text-off-white sm:text-6xl">
                    {asset.symbol}
                  </h1>
                  <p className="mt-3 text-lg text-marketing-text">{asset.name}</p>
                </div>
              </div>

              <div className="w-fit rounded-full border border-marketing-border-muted bg-marketing-surface-active px-4 py-2 text-sm text-marketing-foreground">
                {formatAssetType(asset.type)}
              </div>
            </div>

            <p className="m-0 max-w-3xl text-base leading-7 text-marketing-text">
              {describeTaxMaxiAsset(asset)}
            </p>

            <Separator className="bg-marketing-border-muted" />

            <div className="grid gap-4 sm:grid-cols-2">
              <AssetDetailItem label="Asset ID" value={asset.id} />
              <AssetDetailItem label="Type" value={formatAssetType(asset.type)} />
              <AssetDetailItem
                label="Network representations"
                value={asset.representations.length.toString()}
              />
            </div>
          </div>

          <Card className="border border-marketing-border-muted bg-marketing-surface text-marketing-foreground shadow-none ring-0">
            <CardHeader>
              <CardTitle>Network representations</CardTitle>
              <CardDescription className="text-marketing-muted">
                Exact native, contract, and mint identities that resolve to this economic asset.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {asset.representations.length === 0 ? (
                <p className="m-0 text-sm leading-6 text-marketing-muted">
                  This custody asset has no network-specific representation.
                </p>
              ) : (
                asset.representations.map((representation) => (
                  <AssetRepresentationCard
                    key={representation.id}
                    representation={representation}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <AssetInfoCard
            description="Balances, valuation, FIFO lots, and tax reports use this economic asset ID across every custody source."
            title="Economic identity"
          />
          <AssetInfoCard
            description={
              "On-chain observations also keep the exact network representation used during import and normalization."
            }
            title="Normalization"
          />
        </section>
      </div>
    </AssetsPageShell>
  )
}

function AssetRepresentationCard({
  representation,
}: {
  readonly representation: TaxMaxiAsset["representations"][number]
}) {
  const explorerHref = getAssetRepresentationExplorerHref(representation)
  const address = representation.contractAddress ?? representation.mintAddress
  const typeLabel =
    representation.type === "native" ? "Native" : representation.type === "nft" ? "NFT" : "Token"

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-marketing-border-muted bg-marketing-surface-active p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="m-0 font-medium text-marketing-foreground">
            {formatBlockchainName(representation.blockchainName)}
          </p>
          <p className="mt-1 text-sm text-marketing-muted">
            {typeLabel} · {representation.decimals} decimals
          </p>
        </div>
        {explorerHref ? (
          <Button asChild size="icon-sm" variant="ghost">
            <a
              aria-label={`View ${representation.blockchainName} representation on explorer`}
              href={explorerHref}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink />
            </a>
          </Button>
        ) : null}
      </div>
      {address === null ? (
        <p className="m-0 text-sm text-marketing-muted">Native network asset</p>
      ) : (
        <code className="break-all text-xs text-marketing-foreground">{address}</code>
      )}
    </div>
  )
}

function AssetNotFoundRoute() {
  return (
    <AssetsPageShell>
      <div className="max-w-2xl rounded-[2rem] border border-marketing-border-muted bg-marketing-surface p-6 text-marketing-foreground sm:p-8">
        <p className="m-0 text-sm font-medium uppercase tracking-[0.18em] text-marketing-muted">
          Asset not found
        </p>
        <h1 className="mt-3 font-display text-4xl font-semibold text-off-white">
          No asset matches this ID.
        </h1>
        <p className="mt-4 max-w-xl text-base leading-7 text-marketing-text">
          Check the supported asset list for the current canonical IDs.
        </p>
        <LandingButton asChild className="mt-6" size="pill" variant="control">
          <Link to="/assets">
            <ArrowLeft data-icon="inline-start" />
            Back to assets
          </Link>
        </LandingButton>
      </div>
    </AssetsPageShell>
  )
}

function AssetInfoCard({
  description,
  title,
}: {
  readonly description: string
  readonly title: string
}) {
  return (
    <Card
      className="border border-marketing-border-muted bg-marketing-surface text-marketing-foreground shadow-none ring-0"
      size="sm"
    >
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription className="text-marketing-muted">{description}</CardDescription>
      </CardHeader>
    </Card>
  )
}

function AssetSymbolMark({ asset }: { readonly asset: TaxMaxiAsset }) {
  return (
    <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-[1.5rem] border border-marketing-border-muted bg-marketing-surface-active text-xl font-semibold text-marketing-foreground sm:size-24">
      {asset.logoUrl ? (
        <img alt={`${asset.name} logo`} className="size-full object-cover" src={asset.logoUrl} />
      ) : (
        <span aria-hidden="true">{asset.symbol.slice(0, 2)}</span>
      )}
    </div>
  )
}

function AssetDetailItem({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-marketing-border-muted bg-marketing-surface-active p-4">
      <p className="m-0 text-xs font-medium uppercase tracking-[0.16em] text-marketing-muted">
        {label}
      </p>
      <p className="mt-2 truncate text-base text-marketing-foreground">{value}</p>
    </div>
  )
}
