import { ArrowLeft, ArrowUpRight, CircleDotDashed, Clock3, ShieldCheck } from "lucide-react"
import { Fragment } from "react"

import { useAssetCatalog } from "#/components/asset-catalog-context"
import { AssetExceptionDetailPane } from "#/components/asset-exception-detail"
import { AssetCatalogEmptyState } from "#/components/asset-catalog-empty-state"
import { AssetCatalogItemMark } from "#/components/asset-catalog-item-mark"
import {
  getNetworkNames,
  getPendingAssetName,
  type CatalogItem,
} from "#/components/asset-catalog-model"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Separator } from "#/components/ui/separator"
import { m } from "#/paraglide/messages"
import { localizeHref } from "#/paraglide/runtime"
import {
  describeTaxMaxiAsset,
  formatAssetRepresentationType,
  formatAssetType,
  formatBlockchainName,
  type TaxMaxiPendingAsset,
} from "#/lib/assets"
import { cn } from "#/lib/utils"

export function AssetCatalogDetailPane() {
  const {
    approvedAssetsUnavailable,
    exactLookupOpen,
    exceptionActions,
    isLoading,
    mobileBackButtonRef,
    mobileDetailOpen,
    onShowMobileList,
    pendingAssetsUnavailable,
    query,
    scope,
    selectedItem,
  } = useAssetCatalog()

  return (
    <section
      className={cn(
        "h-full min-w-0 overflow-y-auto overscroll-contain p-5 pb-28 sm:p-8 sm:pb-28 lg:block lg:p-10",
        mobileDetailOpen ? "block" : "hidden"
      )}
    >
      {mobileDetailOpen ? (
        <Button
          className="-ml-2 mb-6 h-11 lg:hidden"
          onClick={onShowMobileList}
          ref={mobileBackButtonRef}
          variant="ghost"
        >
          <ArrowLeft data-icon="inline-start" />
          {m["assetCatalog.actions.backToList"]()}
        </Button>
      ) : null}
      {scope === "exceptions" && exceptionActions !== undefined ? (
        <AssetExceptionDetailPane
          actions={exceptionActions}
          exception={
            !exactLookupOpen && selectedItem?.kind === "exception"
              ? selectedItem.exception
              : undefined
          }
          key={exactLookupOpen ? "exact-lookup" : "catalog-selection"}
        />
      ) : selectedItem ? (
        <CatalogItemDetail item={selectedItem} />
      ) : (
        <AssetCatalogEmptyState
          approvedAssetsUnavailable={approvedAssetsUnavailable && scope !== "pending"}
          isLoading={isLoading}
          pendingAssetsUnavailable={pendingAssetsUnavailable && scope !== "approved"}
          query={query}
        />
      )}
    </section>
  )
}

function CatalogItemDetail({ item }: { readonly item: CatalogItem }) {
  if (item.kind === "exception") {
    return null
  }
  if (item.kind === "pending") {
    return <PendingAssetDetail asset={item.asset} />
  }

  const networkNames = getNetworkNames(item.asset)

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <AssetCatalogItemMark item={item} size="lg" />
          <div className="min-w-0">
            <Badge variant="secondary">
              <ShieldCheck data-icon="inline-start" />
              {m["assetCatalog.detail.approved"]()}
            </Badge>
            <h2 className="mt-3 truncate text-3xl font-semibold tracking-tight sm:text-5xl">
              {item.asset.symbol}
            </h2>
            <p className="mt-1 truncate text-base text-muted-foreground">{item.asset.name}</p>
          </div>
        </div>
        <Badge variant="outline">{formatAssetType(item.asset.type)}</Badge>
      </div>

      <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
        {describeTaxMaxiAsset(item.asset)}
      </p>

      <Button asChild={true} className="h-11 self-start" variant="outline">
        <a href={localizeHref(`/assets/${encodeURIComponent(item.asset.id)}`)}>
          {m["assetCatalog.actions.openPublicPage"]()}
          <ArrowUpRight data-icon="inline-end" />
        </a>
      </Button>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={m["assetCatalog.detail.representations"]()}
          value={item.asset.representations.length.toString()}
        />
        <StatCard
          label={m["assetCatalog.detail.networks"]()}
          value={networkNames.length.toString()}
        />
        <StatCard
          label={m["assetCatalog.detail.registryStatus"]()}
          value={m["assetCatalog.detail.approved"]()}
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-border">
        <div className="px-4 py-3">
          <h3 className="text-sm font-medium">
            {m["assetCatalog.detail.networkRepresentations"]()}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {m["assetCatalog.detail.networkRepresentationsDescription"]()}
          </p>
        </div>
        <Separator />
        {item.asset.representations.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">
            {m["assetCatalog.detail.noNetworkRepresentation"]()}
          </p>
        ) : (
          item.asset.representations.map((representation, index) => (
            <Fragment key={representation.id}>
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium">
                  {formatBlockchainName(representation.blockchainName).slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {formatBlockchainName(representation.blockchainName)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {representation.type === "native"
                      ? m["assetCatalog.detail.nativeNetworkAsset"]()
                      : (representation.contractAddress ??
                        representation.mintAddress ??
                        m["assetCatalog.detail.tokenIdentity"]())}
                  </p>
                </div>
                <Badge variant="outline">
                  {formatAssetRepresentationType(representation.type)}
                </Badge>
              </div>
              {index < item.asset.representations.length - 1 ? <Separator /> : null}
            </Fragment>
          ))
        )}
      </section>
    </div>
  )
}

function PendingAssetDetail({ asset }: { readonly asset: TaxMaxiPendingAsset }) {
  const item: CatalogItem = { kind: "pending", asset }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div className="flex min-w-0 items-center gap-4">
        <AssetCatalogItemMark item={item} size="lg" />
        <div className="min-w-0">
          <Badge variant="outline">
            <Clock3 data-icon="inline-start" />
            {m["assetCatalog.detail.waitingForReview"]()}
          </Badge>
          <h2 className="mt-3 truncate text-3xl font-semibold tracking-tight sm:text-5xl">
            {asset.symbol}
          </h2>
          <p className="mt-1 truncate text-base text-muted-foreground">
            {getPendingAssetName(asset)}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-secondary p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <CircleDotDashed aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div>
            <h3 className="text-sm font-medium">{m["assetCatalog.detail.radarTitle"]()}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {m["assetCatalog.detail.radarDescription"]()}
            </p>
          </div>
        </div>
      </div>

      <dl className="overflow-hidden rounded-2xl border border-border">
        <DetailRow label={m["assetCatalog.detail.reportedBy"]()} value={asset.provider} />
        <Separator />
        <DetailRow
          label={m["assetCatalog.detail.providerAssetId"]()}
          value={asset.providerAssetId ?? m["assetCatalog.detail.notSupplied"]()}
        />
        <Separator />
        <DetailRow
          label={m["assetCatalog.detail.providerType"]()}
          value={asset.providerType ?? m["assetCatalog.detail.notSupplied"]()}
        />
        <Separator />
        <DetailRow
          label={m["assetCatalog.detail.reviewStatus"]()}
          value={m["assetCatalog.detail.waitingForTaxMaxiReview"]()}
        />
      </dl>
    </div>
  )
}

function StatCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 text-card-foreground">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-medium tabular-nums">{value}</p>
    </div>
  )
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm sm:text-right">{value}</dd>
    </div>
  )
}
