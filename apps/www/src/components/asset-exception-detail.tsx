import { ShieldAlert } from "lucide-react"
import { type FormEvent, useState } from "react"

import type { AssetExceptionActions } from "#/components/asset-catalog-context"
import type { TaxMaxiAssetException } from "#/components/asset-catalog-model"
import { AssetExceptionReview } from "#/components/asset-exception-review"
import { useAssetExceptionDetail } from "#/components/asset-exception-review-support"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
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
  const [provider, setProvider] = useState("")
  const [providerAssetId, setProviderAssetId] = useState("")
  const [naturalKey, setNaturalKey] = useState("")
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)

  const lookupSettledObservation = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedProvider = provider.trim()
    const normalizedProviderAssetId = providerAssetId.trim()
    const normalizedNaturalKey = naturalKey.trim()
    if (
      normalizedProvider.length === 0 ||
      Number(normalizedProviderAssetId.length > 0) + Number(normalizedNaturalKey.length > 0) !== 1
    ) {
      setLookupError(m["assetCatalog.exceptions.lookup.invalid"]())
      return
    }

    setLookupLoading(true)
    setLookupError(null)
    try {
      const nextDetail = await actions.lookup(
        normalizedProviderAssetId.length > 0
          ? { provider: normalizedProvider, providerAssetId: normalizedProviderAssetId }
          : { provider: normalizedProvider, naturalKey: normalizedNaturalKey }
      )
      setDetail(nextDetail)
    } catch {
      setLookupError(m["assetCatalog.exceptions.lookup.error"]())
    } finally {
      setLookupLoading(false)
    }
  }

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
        {loading ? null : (
          <form
            className="grid gap-3 rounded-2xl border border-border p-5"
            onSubmit={(event) => void lookupSettledObservation(event)}
          >
            <div>
              <h2 className="text-base font-medium">
                {m["assetCatalog.exceptions.lookup.title"]()}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {m["assetCatalog.exceptions.lookup.description"]()}
              </p>
            </div>
            <Input
              aria-label={m["assetCatalog.exceptions.lookup.provider"]()}
              onChange={(event) => setProvider(event.currentTarget.value)}
              placeholder={m["assetCatalog.exceptions.lookup.provider"]()}
              value={provider}
            />
            <Input
              aria-label={m["assetCatalog.exceptions.providerAssetId"]()}
              onChange={(event) => setProviderAssetId(event.currentTarget.value)}
              placeholder={m["assetCatalog.exceptions.providerAssetId"]()}
              value={providerAssetId}
            />
            <Input
              aria-label={m["assetCatalog.exceptions.naturalKey"]()}
              onChange={(event) => setNaturalKey(event.currentTarget.value)}
              placeholder={m["assetCatalog.exceptions.naturalKey"]()}
              value={naturalKey}
            />
            {lookupError === null ? null : (
              <p className="text-sm text-destructive" role="alert">
                {lookupError}
              </p>
            )}
            <Button className="h-11 justify-self-start" disabled={lookupLoading} type="submit">
              {lookupLoading
                ? m["assetCatalog.exceptions.lookup.loading"]()
                : m["assetCatalog.exceptions.lookup.action"]()}
            </Button>
          </form>
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
