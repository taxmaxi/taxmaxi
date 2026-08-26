import { ShieldAlert } from "lucide-react"

import type { AssetExceptionActions } from "#/components/asset-catalog-context"
import type { TaxMaxiAssetException } from "#/components/asset-catalog-model"
import { AssetExceptionReview } from "#/components/asset-exception-review"
import { useAssetExceptionDetail } from "#/components/asset-exception-review-support"
import { m } from "#/paraglide/messages"

export function AssetExceptionDetailPane({
  actions,
  exception,
}: {
  readonly actions: AssetExceptionActions
  readonly exception?: TaxMaxiAssetException
}) {
  const { detail, loadError, loading, setDetail } = useAssetExceptionDetail(
    actions,
    exception?.providerAssetRowId
  )

  if (detail === null) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {loadError === null ? null : (
          <p className="text-sm text-destructive" role="alert">
            {loadError}
          </p>
        )}
        {loading ? (
          <div
            aria-label={m["assetCatalog.exceptions.loading"]()}
            className="grid gap-4"
            role="status"
          >
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
            <div className="h-40 animate-pulse rounded-xl bg-muted" />
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center">
            <ShieldAlert aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">{m["assetCatalog.exceptions.emptyDetail"]()}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <AssetExceptionReview
      actions={actions}
      detail={detail}
      exception={
        exception?.providerAssetRowId === detail.providerAssetRowId ? exception : undefined
      }
      key={detail.providerAssetRowId}
      onDetailChange={setDetail}
      stale={loading}
    />
  )
}
