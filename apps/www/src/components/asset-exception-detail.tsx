import { AlertTriangle, CheckCircle2, Search, ShieldAlert } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  getTaxMaxiAssetDecisionErrorCode,
  type AssetExceptionDecisionInput,
  type AssetExceptionDetail,
  type AssetExceptionPreview,
  type TaxMaxiAssetDecisionErrorCode,
} from "taxmaxi"

import type { AssetExceptionActions } from "#/components/asset-catalog-context"
import type { TaxMaxiAssetException } from "#/components/asset-catalog-model"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Separator } from "#/components/ui/separator"
import { m } from "#/paraglide/messages"

type DecisionMode = "existing" | "new" | "exclusion"
type LookupKind = "provider_asset_id" | "natural_key"

const decisionErrorMessage = (code: TaxMaxiAssetDecisionErrorCode | null): string | null => {
  switch (code) {
    case "stale_revision":
      return m["assetCatalog.exceptions.errors.stale"]()
    case "ambiguous_identity":
      return m["assetCatalog.exceptions.errors.ambiguousIdentity"]()
    case "identity_changed":
      return m["assetCatalog.exceptions.errors.identityChanged"]()
    case "invalid_evidence":
      return m["assetCatalog.exceptions.errors.invalidEvidence"]()
    case "invalid_claim":
      return m["assetCatalog.exceptions.errors.invalidClaim"]()
    case null:
      return null
  }
}

export function AssetExceptionDetailPane({
  actions,
  exception,
}: {
  readonly actions: AssetExceptionActions
  readonly exception?: TaxMaxiAssetException
}) {
  const [detail, setDetail] = useState<AssetExceptionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lookupProvider, setLookupProvider] = useState("")
  const [lookupKind, setLookupKind] = useState<LookupKind>("provider_asset_id")
  const [lookupKey, setLookupKey] = useState("")
  const detailRequestId = useRef(0)
  const renderedExceptionId = useRef(exception?.providerAssetRowId)

  if (renderedExceptionId.current !== exception?.providerAssetRowId) {
    renderedExceptionId.current = exception?.providerAssetRowId
    detailRequestId.current += 1
  }

  const loadDetail = async (id: string) => {
    const requestId = ++detailRequestId.current
    setLoading(true)
    setError(null)
    try {
      const nextDetail = await actions.get(id)
      if (requestId === detailRequestId.current) {
        setDetail(nextDetail)
      }
    } catch {
      if (requestId === detailRequestId.current) {
        setError(m["assetCatalog.exceptions.errors.load"]())
      }
    } finally {
      if (requestId === detailRequestId.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (exception === undefined) {
      detailRequestId.current += 1
      setDetail(null)
      return
    }
    setDetail(null)
    void loadDetail(exception.providerAssetRowId)
  }, [exception?.providerAssetRowId])

  const lookup = async () => {
    const provider = lookupProvider.trim()
    const key = lookupKey.trim()
    if (provider.length === 0 || key.length === 0) {
      setError(m["assetCatalog.exceptions.errors.lookupFields"]())
      return
    }
    setLoading(true)
    setError(null)
    setDetail(null)
    const requestId = ++detailRequestId.current
    try {
      const nextDetail = await actions.lookup(
        lookupKind === "provider_asset_id"
          ? { provider, providerAssetId: key }
          : { provider, naturalKey: key }
      )
      if (requestId === detailRequestId.current) {
        setDetail(nextDetail)
      }
    } catch {
      if (requestId === detailRequestId.current) {
        setError(m["assetCatalog.exceptions.errors.lookup"]())
      }
    } finally {
      if (requestId === detailRequestId.current) {
        setLoading(false)
      }
    }
  }

  const reviewRequestId = detailRequestId.current

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <Search aria-hidden="true" className="size-4" />
          <h2 className="text-sm font-medium">{m["assetCatalog.exceptions.lookup.title"]()}</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {m["assetCatalog.exceptions.lookup.description"]()}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_minmax(0,1fr)_auto]">
          <Field
            label={m["assetCatalog.exceptions.lookup.provider"]()}
            onChange={setLookupProvider}
            value={lookupProvider}
          />
          <label className="grid gap-1 text-xs text-muted-foreground">
            {m["assetCatalog.exceptions.lookup.keyType"]()}
            <select
              className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground"
              onChange={(event) =>
                setLookupKind(
                  event.currentTarget.value === "natural_key" ? "natural_key" : "provider_asset_id"
                )
              }
              value={lookupKind}
            >
              <option value="provider_asset_id">
                {m["assetCatalog.exceptions.lookup.providerAssetId"]()}
              </option>
              <option value="natural_key">
                {m["assetCatalog.exceptions.lookup.naturalKey"]()}
              </option>
            </select>
          </label>
          <Field
            label={m["assetCatalog.exceptions.lookup.key"]()}
            onChange={setLookupKey}
            value={lookupKey}
          />
          <Button className="h-10 self-end" disabled={loading} onClick={() => void lookup()}>
            {m["assetCatalog.exceptions.lookup.action"]()}
          </Button>
        </div>
      </section>

      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {loading && detail === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          {m["assetCatalog.exceptions.loading"]()}
        </p>
      ) : null}
      {detail === null ? (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center">
          <ShieldAlert aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">{m["assetCatalog.exceptions.emptyDetail"]()}</p>
        </div>
      ) : (
        <AssetExceptionReview
          actions={actions}
          detail={detail}
          key={detail.providerAssetRowId}
          onDetailChange={(nextDetail) => {
            if (
              reviewRequestId === detailRequestId.current &&
              nextDetail.providerAssetRowId === detail.providerAssetRowId
            ) {
              setDetail(nextDetail)
            }
          }}
        />
      )}
    </div>
  )
}

function AssetExceptionReview({
  actions,
  detail,
  onDetailChange,
}: {
  readonly actions: AssetExceptionActions
  readonly detail: AssetExceptionDetail
  readonly onDetailChange: (detail: AssetExceptionDetail) => void
}) {
  const resolverAssetId = detail.activeDecision?.assetId ?? ""
  const [mode, setMode] = useState<DecisionMode>(
    resolverAssetId.length > 0 ? "existing" : "exclusion"
  )
  const [assetId, setAssetId] = useState(resolverAssetId)
  const [name, setName] = useState(detail.name ?? "")
  const [symbol, setSymbol] = useState(detail.currencyCode)
  const [assetType, setAssetType] = useState<"fungible" | "nft">("fungible")
  const [blockchain, setBlockchain] = useState("")
  const [representationType, setRepresentationType] = useState<"native" | "token" | "nft">("token")
  const [address, setAddress] = useState("")
  const [addressKind, setAddressKind] = useState<"contract" | "mint">("contract")
  const [decimals, setDecimals] = useState("")
  const [exclusionReason, setExclusionReason] = useState<
    "authority_banned" | "confirmed_spam" | "unsupported_asset_type" | "provider_artifact"
  >("confirmed_spam")
  const [rationale, setRationale] = useState("")
  const [selectedEvidence, setSelectedEvidence] = useState<ReadonlyArray<string>>(
    detail.evidence.map((evidence) => evidence.id)
  )
  const [preview, setPreview] = useState<{
    readonly request: AssetExceptionDecisionInput
    readonly response: AssetExceptionPreview
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setAssetId(detail.activeDecision?.assetId ?? "")
    setSelectedEvidence(detail.evidence.map((evidence) => evidence.id))
    setPreview(null)
  }, [detail.activeDecisionRevision, detail.evidenceRevision])

  const impact = detail.impact
  const refreshAfterStaleDecision = async (): Promise<string> => {
    try {
      onDetailChange(await actions.get(detail.providerAssetRowId))
      return m["assetCatalog.exceptions.errors.stale"]()
    } catch {
      return m["assetCatalog.exceptions.errors.staleRefresh"]()
    }
  }

  const makeRequest = (): AssetExceptionDecisionInput | null => {
    const trimmedRationale = rationale.trim()
    if (trimmedRationale.length === 0 || selectedEvidence.length === 0) {
      setMessage(m["assetCatalog.exceptions.errors.rationaleEvidence"]())
      return null
    }

    const representation =
      mode === "exclusion"
        ? null
        : (() => {
            if (
              blockchain.trim().length === 0 &&
              address.trim().length === 0 &&
              decimals.trim().length === 0
            ) {
              return null
            }
            const decimalCount = Number(decimals)
            const identityAddress = address.trim()
            if (
              !Number.isInteger(decimalCount) ||
              decimalCount < 0 ||
              blockchain.trim().length === 0 ||
              (representationType === "native" && identityAddress.length > 0) ||
              (representationType !== "native" && identityAddress.length === 0)
            ) {
              return undefined
            }
            return {
              blockchain: blockchain.trim(),
              type: representationType,
              contractAddress:
                representationType !== "native" && addressKind === "contract"
                  ? identityAddress
                  : null,
              mintAddress:
                representationType !== "native" && addressKind === "mint" ? identityAddress : null,
              decimals: decimalCount,
            }
          })()
    if (representation === undefined) {
      setMessage(m["assetCatalog.exceptions.errors.representation"]())
      return null
    }

    const claim = (() => {
      switch (mode) {
        case "exclusion":
          return { _tag: "exclusion" as const, reason: exclusionReason }
        case "existing":
          if (assetId.trim().length === 0) {
            return null
          }
          return {
            _tag: "identity" as const,
            assetId: assetId.trim(),
            newAsset: null,
            representation,
          }
        case "new":
          if (name.trim().length === 0 || symbol.trim().length === 0) {
            return null
          }
          return {
            _tag: "identity" as const,
            assetId: null,
            newAsset: { name: name.trim(), symbol: symbol.trim(), type: assetType },
            representation,
          }
      }
    })()
    if (claim === null) {
      setMessage(m["assetCatalog.exceptions.errors.claim"]())
      return null
    }

    return {
      id: detail.providerAssetRowId,
      claim,
      evidenceRevision: detail.evidenceRevision,
      activeDecisionRevision: detail.activeDecisionRevision,
      evidenceSnapshotIds: selectedEvidence,
      rationale: trimmedRationale,
    }
  }

  const previewDecision = async () => {
    const request = makeRequest()
    if (request === null) {
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      setPreview({ request, response: await actions.preview(request) })
    } catch (cause) {
      const code = getTaxMaxiAssetDecisionErrorCode(cause)
      const decisionError = decisionErrorMessage(code)
      if (code === "stale_revision") {
        setMessage(await refreshAfterStaleDecision())
      } else if (decisionError !== null) {
        setMessage(decisionError)
      } else {
        setMessage(m["assetCatalog.exceptions.errors.preview"]())
      }
    } finally {
      setBusy(false)
    }
  }

  const confirmDecision = async () => {
    if (preview === null) {
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const nextDetail = await actions.submit({
        id: preview.request.id,
        claim: preview.request.claim,
        evidenceRevision: preview.request.evidenceRevision,
        activeDecisionRevision: preview.request.activeDecisionRevision,
        evidenceSnapshotIds: preview.request.evidenceSnapshotIds,
        rationale: preview.request.rationale,
        expectedResultingAssetId: preview.response.resultingAssetId,
        expectedAssetOutcome: preview.response.assetOutcome,
        expectedRepresentationOutcome: preview.response.representationOutcome,
      })
      onDetailChange(nextDetail)
      setPreview(null)
      setMessage(m["assetCatalog.exceptions.success"]())
    } catch (cause) {
      const code = getTaxMaxiAssetDecisionErrorCode(cause)
      const decisionError = decisionErrorMessage(code)
      if (code === "stale_revision") {
        setMessage(await refreshAfterStaleDecision())
      } else if (decisionError !== null) {
        setMessage(decisionError)
      } else {
        setMessage(m["assetCatalog.exceptions.errors.submit"]())
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{detail.provider}</Badge>
            <Badge variant="secondary">{reviewStatusLabel(detail.reviewStatus)}</Badge>
          </div>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            {detail.currencyCode}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.name ?? m["assetCatalog.detail.notSupplied"]()}
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>
            {m["assetCatalog.exceptions.evidenceRevision"]({ revision: detail.evidenceRevision })}
          </p>
          <p>{m["assetCatalog.exceptions.policyRevision"]({ revision: detail.policyRevision })}</p>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric
          label={m["assetCatalog.exceptions.impact.blockedReports"]()}
          value={impact.blockedReports}
        />
        <Metric
          label={m["assetCatalog.exceptions.impact.principals"]()}
          value={impact.affectedPrincipals}
        />
        <Metric
          label={m["assetCatalog.exceptions.impact.transactions"]()}
          value={impact.affectedTransactions}
        />
        <Metric
          label={m["assetCatalog.exceptions.impact.sources"]()}
          value={impact.affectedSources}
        />
        <Metric
          label={m["assetCatalog.exceptions.impact.valueEur"]()}
          value={impact.affectedTransactionValueEur ?? m["assetCatalog.exceptions.unknown"]()}
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-border">
        <SectionHeader
          description={m["assetCatalog.exceptions.policy.description"]()}
          title={m["assetCatalog.exceptions.policy.title"]()}
        />
        <Separator />
        <dl className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <Fact
            label={m["assetCatalog.exceptions.policy.outcome"]()}
            value={
              detail.policyOutput === null
                ? m["assetCatalog.exceptions.unknown"]()
                : decisionOutcomeLabel(detail.policyOutput.outcome)
            }
          />
          <Fact
            label={m["assetCatalog.exceptions.policy.reason"]()}
            value={reasonLabel(detail.policyOutput?.reason ?? null)}
          />
          <Fact
            label={m["assetCatalog.exceptions.providerAssetId"]()}
            value={detail.providerAssetId ?? m["assetCatalog.detail.notSupplied"]()}
          />
          <Fact
            label={m["assetCatalog.exceptions.naturalKey"]()}
            value={detail.naturalKey ?? m["assetCatalog.detail.notSupplied"]()}
          />
        </dl>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border">
        <SectionHeader
          description={m["assetCatalog.exceptions.evidence.description"]()}
          title={m["assetCatalog.exceptions.evidence.title"]()}
        />
        <Separator />
        {detail.evidence.map((evidence) => (
          <label
            className="grid gap-2 border-b border-border p-4 last:border-b-0"
            key={evidence.id}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <input
                checked={selectedEvidence.includes(evidence.id)}
                disabled={busy || preview !== null}
                onChange={(event) =>
                  setSelectedEvidence((current) =>
                    event.currentTarget.checked
                      ? [...current, evidence.id]
                      : current.filter((id) => id !== evidence.id)
                  )
                }
                type="checkbox"
              />
              {evidence.authority} · {evidenceClaimKindLabel(evidence.claimKind)}
            </span>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
              {formatJson(evidence.decodedClaim)}
            </pre>
          </label>
        ))}
      </section>

      <section className="overflow-hidden rounded-2xl border border-border">
        <SectionHeader
          description={m["assetCatalog.exceptions.history.description"]()}
          title={m["assetCatalog.exceptions.history.title"]()}
        />
        <Separator />
        {detail.decisionHistory.map((decision) => (
          <div
            className="grid gap-2 border-b border-border p-4 text-xs last:border-b-0"
            key={decision.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={decision.status === "active" ? "secondary" : "outline"}>
                {decisionStatusLabel(decision.status)}
              </Badge>
              <span>{decisionOutcomeLabel(decision.outcome)}</span>
              <span className="text-muted-foreground">{decision.actorId}</span>
            </div>
            <p>{decision.rationale ?? reasonLabel(decision.reason)}</p>
            <p className="text-muted-foreground">
              {decision.evidenceSnapshotIds.length}{" "}
              {m["assetCatalog.exceptions.history.evidenceLinks"]()}
            </p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-border p-4 sm:p-5">
        <div className="flex items-center gap-2">
          {detail.rematerialization.status === "operator_attention" ? (
            <AlertTriangle aria-hidden="true" className="size-4 text-destructive" />
          ) : (
            <CheckCircle2 aria-hidden="true" className="size-4" />
          )}
          <h3 className="text-sm font-medium">
            {m["assetCatalog.exceptions.rematerialization.title"]()}
          </h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {rematerializationLabel(detail.rematerialization.status)} ·{" "}
          {detail.rematerialization.affectedSourceCount}{" "}
          {m["assetCatalog.exceptions.impact.sources"]()}
        </p>
        {detail.rematerialization.status === "operator_attention" ? (
          <p className="mt-2 text-xs text-destructive">
            {m["assetCatalog.exceptions.rematerialization.operatorAttention"]({
              count: detail.rematerialization.failedSourceCount,
            })}
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <h3 className="text-sm font-medium">{m["assetCatalog.exceptions.decision.title"]()}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {m["assetCatalog.exceptions.decision.description"]()}
        </p>
        <fieldset className="mt-4 grid gap-4" disabled={busy || preview !== null}>
          <label className="grid gap-1 text-xs text-muted-foreground">
            {m["assetCatalog.exceptions.decision.kind"]()}
            <select
              className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground"
              onChange={(event) =>
                setMode(
                  event.currentTarget.value === "new"
                    ? "new"
                    : event.currentTarget.value === "existing"
                      ? "existing"
                      : "exclusion"
                )
              }
              value={mode}
            >
              <option value="existing">
                {m["assetCatalog.exceptions.decision.existingIdentity"]()}
              </option>
              <option value="new">{m["assetCatalog.exceptions.decision.newIdentity"]()}</option>
              <option value="exclusion">{m["assetCatalog.exceptions.decision.exclusion"]()}</option>
            </select>
          </label>

          {mode === "existing" ? (
            <Field
              label={m["assetCatalog.exceptions.decision.assetId"]()}
              onChange={setAssetId}
              value={assetId}
            />
          ) : mode === "new" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field
                label={m["assetCatalog.exceptions.decision.name"]()}
                onChange={setName}
                value={name}
              />
              <Field
                label={m["assetCatalog.exceptions.decision.symbol"]()}
                onChange={setSymbol}
                value={symbol}
              />
              <label className="grid gap-1 text-xs text-muted-foreground">
                {m["assetCatalog.exceptions.decision.assetType"]()}
                <select
                  className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground"
                  onChange={(event) =>
                    setAssetType(event.currentTarget.value === "nft" ? "nft" : "fungible")
                  }
                  value={assetType}
                >
                  <option value="fungible">{m["assetCatalog.assetType.fungible"]()}</option>
                  <option value="nft">{m["assetCatalog.assetType.nft"]()}</option>
                </select>
              </label>
            </div>
          ) : (
            <label className="grid gap-1 text-xs text-muted-foreground">
              {m["assetCatalog.exceptions.decision.exclusionReason"]()}
              <select
                className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground"
                onChange={(event) =>
                  setExclusionReason(exclusionReasonFromValue(event.currentTarget.value))
                }
                value={exclusionReason}
              >
                <option value="authority_banned">
                  {m["assetCatalog.exceptions.exclusion.authorityBanned"]()}
                </option>
                <option value="confirmed_spam">
                  {m["assetCatalog.exceptions.exclusion.confirmedSpam"]()}
                </option>
                <option value="unsupported_asset_type">
                  {m["assetCatalog.exceptions.exclusion.unsupportedAssetType"]()}
                </option>
                <option value="provider_artifact">
                  {m["assetCatalog.exceptions.exclusion.providerArtifact"]()}
                </option>
              </select>
            </label>
          )}

          {mode === "exclusion" ? null : (
            <div className="grid gap-3 sm:grid-cols-5">
              <Field
                label={m["assetCatalog.exceptions.decision.blockchain"]()}
                onChange={setBlockchain}
                value={blockchain}
              />
              <label className="grid gap-1 text-xs text-muted-foreground">
                {m["assetCatalog.exceptions.decision.representationType"]()}
                <select
                  className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground"
                  onChange={(event) =>
                    setRepresentationType(representationTypeFromValue(event.currentTarget.value))
                  }
                  value={representationType}
                >
                  <option value="native">{m["assetCatalog.representationType.native"]()}</option>
                  <option value="token">{m["assetCatalog.representationType.token"]()}</option>
                  <option value="nft">{m["assetCatalog.representationType.nft"]()}</option>
                </select>
              </label>
              {representationType === "native" ? (
                <span aria-hidden="true" />
              ) : (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {m["assetCatalog.exceptions.decision.addressKind"]()}
                  <select
                    className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground"
                    onChange={(event) =>
                      setAddressKind(event.currentTarget.value === "mint" ? "mint" : "contract")
                    }
                    value={addressKind}
                  >
                    <option value="contract">
                      {m["assetCatalog.exceptions.decision.contractAddress"]()}
                    </option>
                    <option value="mint">
                      {m["assetCatalog.exceptions.decision.mintAddress"]()}
                    </option>
                  </select>
                </label>
              )}
              <Field
                label={m["assetCatalog.exceptions.decision.address"]()}
                onChange={setAddress}
                value={address}
              />
              <Field
                label={m["assetCatalog.exceptions.decision.decimals"]()}
                onChange={setDecimals}
                value={decimals}
              />
            </div>
          )}

          <label className="grid gap-1 text-xs text-muted-foreground">
            {m["assetCatalog.exceptions.decision.rationale"]()}
            <textarea
              className="min-h-24 rounded-md border border-border bg-background p-3 text-sm text-foreground"
              onChange={(event) => setRationale(event.currentTarget.value)}
              value={rationale}
            />
          </label>
        </fieldset>

        {message === null ? null : (
          <p className="mt-3 text-sm" role="status">
            {message}
          </p>
        )}

        {preview === null ? (
          <Button className="mt-4" disabled={busy} onClick={() => void previewDecision()}>
            {m["assetCatalog.exceptions.decision.preview"]()}
          </Button>
        ) : (
          <div className="mt-4 rounded-xl border border-border bg-background p-4">
            <h4 className="text-sm font-medium">{m["assetCatalog.exceptions.preview.title"]()}</h4>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <Fact
                label={m["assetCatalog.exceptions.preview.decisionAction"]()}
                value={decisionActionLabel(preview.response.decisionAction)}
              />
              <Fact
                label={m["assetCatalog.exceptions.preview.assetOutcome"]()}
                value={previewOutcomeLabel(preview.response.assetOutcome)}
              />
              <Fact
                label={m["assetCatalog.exceptions.preview.representationOutcome"]()}
                value={previewOutcomeLabel(preview.response.representationOutcome)}
              />
              <Fact
                label={m["assetCatalog.exceptions.preview.sources"]()}
                value={preview.response.rematerializationSourceCount.toString()}
              />
              <Fact
                label={m["assetCatalog.exceptions.preview.supersedes"]()}
                value={
                  preview.response.supersededDecision?.id ??
                  m["assetCatalog.exceptions.preview.none"]()
                }
              />
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void confirmDecision()}>
                {m["assetCatalog.exceptions.decision.confirm"]()}
              </Button>
              <Button disabled={busy} onClick={() => setPreview(null)} variant="outline">
                {m["assetCatalog.exceptions.decision.edit"]()}
              </Button>
            </div>
          </div>
        )}
      </section>
    </>
  )
}

function Field({
  label,
  onChange,
  value,
}: {
  readonly label: string
  readonly onChange: (value: string) => void
  readonly value: string
}) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <input
        className="h-10 min-w-0 rounded-md border border-border bg-background px-3 text-sm text-foreground"
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      />
    </label>
  )
}

function Metric({ label, value }: { readonly label: string; readonly value: number | string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-medium tabular-nums">{value}</p>
    </div>
  )
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-sm">{value}</dd>
    </div>
  )
}

function SectionHeader({
  description,
  title,
}: {
  readonly description: string
  readonly title: string
}) {
  return (
    <div className="p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null"
  } catch {
    return m["assetCatalog.exceptions.evidence.unavailable"]()
  }
}

function reviewStatusLabel(status: "unresolved" | "approved" | "excluded"): string {
  switch (status) {
    case "unresolved":
      return m["assetCatalog.exceptions.review.unresolved"]()
    case "approved":
      return m["assetCatalog.exceptions.review.approved"]()
    case "excluded":
      return m["assetCatalog.exceptions.review.excluded"]()
  }
}

function decisionStatusLabel(status: "active" | "superseded"): string {
  return status === "active"
    ? m["assetCatalog.exceptions.labels.status.active"]()
    : m["assetCatalog.exceptions.labels.status.superseded"]()
}

function decisionOutcomeLabel(
  outcome: "attach" | "create_standalone" | "identity" | "excluded" | "pending" | "fail_closed"
): string {
  switch (outcome) {
    case "attach":
      return m["assetCatalog.exceptions.labels.outcome.attach"]()
    case "create_standalone":
      return m["assetCatalog.exceptions.labels.outcome.createStandalone"]()
    case "identity":
      return m["assetCatalog.exceptions.labels.outcome.identity"]()
    case "excluded":
      return m["assetCatalog.exceptions.labels.outcome.excluded"]()
    case "pending":
      return m["assetCatalog.exceptions.labels.outcome.pending"]()
    case "fail_closed":
      return m["assetCatalog.exceptions.labels.outcome.failClosed"]()
  }
}

function reasonLabel(reason: string | null): string {
  switch (reason) {
    case "ownership_conflict":
      return m["assetCatalog.exceptions.labels.reason.ownershipConflict"]()
    case "conflicting_evidence":
      return m["assetCatalog.exceptions.labels.reason.conflictingEvidence"]()
    case "incompatible_decimals":
      return m["assetCatalog.exceptions.labels.reason.incompatibleDecimals"]()
    case "incompatible_type":
      return m["assetCatalog.exceptions.labels.reason.incompatibleType"]()
    case "malformed_payload":
      return m["assetCatalog.exceptions.labels.reason.malformedPayload"]()
    case "upstream_failure":
      return m["assetCatalog.exceptions.labels.reason.upstreamFailure"]()
    case "display_collision":
      return m["assetCatalog.exceptions.labels.reason.displayCollision"]()
    case "non_exact_platform_match":
      return m["assetCatalog.exceptions.labels.reason.nonExactPlatformMatch"]()
    case "spam_evidence":
      return m["assetCatalog.exceptions.labels.reason.spamEvidence"]()
    case "unsupported_representation_type":
      return m["assetCatalog.exceptions.labels.reason.unsupportedRepresentationType"]()
    case "authority_banned":
      return m["assetCatalog.exceptions.exclusion.authorityBanned"]()
    case "confirmed_spam":
      return m["assetCatalog.exceptions.exclusion.confirmedSpam"]()
    case "unsupported_asset_type":
      return m["assetCatalog.exceptions.exclusion.unsupportedAssetType"]()
    case "provider_artifact":
      return m["assetCatalog.exceptions.exclusion.providerArtifact"]()
    case "manual_exclusion_reversal":
      return m["assetCatalog.exceptions.labels.reason.manualExclusionReversal"]()
    default:
      return m["assetCatalog.exceptions.unknown"]()
  }
}

function evidenceClaimKindLabel(claimKind: string): string {
  switch (claimKind) {
    case "chain_fact":
      return m["assetCatalog.exceptions.evidence.chainFact"]()
    case "registry_platform_mapping":
      return m["assetCatalog.exceptions.evidence.platformMapping"]()
    case "legitimacy":
      return m["assetCatalog.exceptions.evidence.legitimacy"]()
    case "representation":
      return m["assetCatalog.exceptions.evidence.representation"]()
    default:
      return m["assetCatalog.exceptions.evidence.otherClaim"]()
  }
}

function previewOutcomeLabel(outcome: "none" | "reuse" | "create"): string {
  switch (outcome) {
    case "none":
      return m["assetCatalog.exceptions.preview.none"]()
    case "reuse":
      return m["assetCatalog.exceptions.labels.preview.reuse"]()
    case "create":
      return m["assetCatalog.exceptions.labels.preview.create"]()
  }
}

function decisionActionLabel(action: "initial" | "supersession" | "reversal"): string {
  switch (action) {
    case "initial":
      return m["assetCatalog.exceptions.labels.action.initial"]()
    case "supersession":
      return m["assetCatalog.exceptions.labels.action.supersession"]()
    case "reversal":
      return m["assetCatalog.exceptions.labels.action.reversal"]()
  }
}

function rematerializationLabel(
  status: "pending" | "running" | "complete" | "operator_attention"
): string {
  switch (status) {
    case "pending":
      return m["assetCatalog.exceptions.rematerialization.pending"]()
    case "running":
      return m["assetCatalog.exceptions.rematerialization.running"]()
    case "complete":
      return m["assetCatalog.exceptions.rematerialization.complete"]()
    case "operator_attention":
      return m["assetCatalog.exceptions.rematerialization.operatorAttentionLabel"]()
  }
}

function exclusionReasonFromValue(
  value: string
): "authority_banned" | "confirmed_spam" | "unsupported_asset_type" | "provider_artifact" {
  switch (value) {
    case "authority_banned":
    case "confirmed_spam":
    case "unsupported_asset_type":
    case "provider_artifact":
      return value
    default:
      return "confirmed_spam"
  }
}

function representationTypeFromValue(value: string): "native" | "token" | "nft" {
  switch (value) {
    case "native":
    case "token":
    case "nft":
      return value
    default:
      return "token"
  }
}
