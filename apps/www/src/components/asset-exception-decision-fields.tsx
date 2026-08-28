/** Form controls for reviewing and confirming an asset exception decision. */
import { AlertTriangle, BadgeCheck, Check, Database, Search } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { AssetCatalogAsset } from "taxmaxi"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Textarea } from "#/components/ui/textarea"
import { readableAssetLabel } from "#/lib/assets"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

import {
  EXCLUSION_REASONS,
  availableExclusionReasons,
  exclusionReasonText,
  observedRepresentation,
  registryCoinId,
  type DecisionDraft,
} from "./asset-exception-review-support"

function FieldLabel({
  children,
  error,
}: {
  readonly children: React.ReactNode
  readonly error?: string
}) {
  return (
    <span
      className={cn("text-xs", error === undefined ? "text-muted-foreground" : "text-destructive")}
    >
      {children}
    </span>
  )
}

export function ClaimFields({
  dense = false,
  draft,
}: {
  readonly dense?: boolean
  readonly draft: DecisionDraft
}) {
  const claimError = draft.fieldErrors.claim

  if (draft.mode === "existing") {
    return <CandidatePicker draft={draft} />
  }

  if (draft.mode === "new") {
    return (
      <div className={cn("grid gap-3", dense ? "" : "sm:grid-cols-3")}>
        <label className="grid gap-1">
          <FieldLabel error={claimError}>
            {m["assetCatalog.exceptions.decision.name"]()} *
          </FieldLabel>
          <Input
            aria-invalid={claimError !== undefined}
            onChange={(event) => draft.setName(event.currentTarget.value)}
            value={draft.name}
          />
        </label>
        <label className="grid gap-1">
          <FieldLabel error={claimError}>
            {m["assetCatalog.exceptions.decision.symbol"]()} *
          </FieldLabel>
          <Input
            aria-invalid={claimError !== undefined}
            onChange={(event) => draft.setSymbol(event.currentTarget.value)}
            value={draft.symbol}
          />
        </label>
        <label className="grid gap-1">
          <FieldLabel>{m["assetCatalog.exceptions.decision.assetType"]()}</FieldLabel>
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            onChange={(event) =>
              draft.setAssetType(event.currentTarget.value === "nft" ? "nft" : "fungible")
            }
            value={draft.assetType}
          >
            <option value="fungible">
              {m["assetCatalog.exceptions.reviewUi.form.fungible"]()}
            </option>
            <option value="nft">{m["assetCatalog.exceptions.reviewUi.form.nft"]()}</option>
          </select>
        </label>
        {claimError === undefined ? null : (
          <p className={cn("text-xs text-destructive", dense ? "" : "sm:col-span-3")}>
            {claimError}
          </p>
        )}
      </div>
    )
  }

  if (draft.mode === "exclusion") {
    const reasons = availableExclusionReasons(draft.detail)
    if (reasons.length === 1) {
      const [reason] = reasons
      const text = exclusionReasonText(reason)
      return (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <FieldLabel>{m["assetCatalog.exceptions.reviewUi.form.whyExcluded"]()}</FieldLabel>
          <p className="mt-1 text-sm font-medium">{text.label}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{text.description}</p>
        </div>
      )
    }
    return (
      <div
        aria-label={m["assetCatalog.exceptions.reviewUi.form.whyExclude"]()}
        className="grid gap-2"
        role="radiogroup"
      >
        <FieldLabel>{m["assetCatalog.exceptions.reviewUi.form.whyExclude"]()}</FieldLabel>
        {reasons.map((reason) => {
          const selected = draft.exclusionReason === reason
          const text = exclusionReasonText(reason)
          return (
            <button
              aria-checked={selected}
              className={cn(
                "rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/50"
              )}
              key={reason}
              onClick={() => draft.setExclusionReason(reason)}
              role="radio"
              type="button"
            >
              <span className="text-sm font-medium">{text.label}</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                {text.description}
              </span>
            </button>
          )
        })}
      </div>
    )
  }

  return null
}

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]+$/

/**
 * The catalog stores EVM addresses lowercased while chain evidence often
 * carries checksummed ones, so hex addresses compare case-insensitively.
 * Case stays significant for chains such as Solana, where base58 addresses
 * differing only in case are different accounts.
 */
function isSameAddress(candidate: string | null, observed: string): boolean {
  if (candidate === null) {
    return false
  }
  return HEX_ADDRESS_PATTERN.test(candidate) && HEX_ADDRESS_PATTERN.test(observed)
    ? candidate.toLowerCase() === observed.toLowerCase()
    : candidate === observed
}

/**
 * Candidate search for "attach to existing asset": shows matching catalog
 * assets with their mint and trust signals instead of asking for a UUID.
 */
function CandidatePicker({ draft }: { readonly draft: DecisionDraft }) {
  const claimError = draft.fieldErrors.claim
  // Search by symbol or name only when they are readable; an invisible spam
  // symbol would search the catalog for an empty-looking string.
  const initialQuery =
    readableAssetLabel(draft.detail.currencyCode) ?? readableAssetLabel(draft.detail.name) ?? ""
  const [query, setQuery] = useState(initialQuery)
  const [candidates, setCandidates] = useState<ReadonlyArray<AssetCatalogAsset> | null>(null)
  const [busy, setBusy] = useState(false)
  const search = draft.searchAssets
  // Searches can overlap when the reviewer refines the query before the
  // previous request settles; only the latest request may update the list.
  const latestSearchId = useRef(0)

  const runSearch = (value: string, clearSelection = true) => {
    if (value.trim().length === 0) {
      return
    }
    if (clearSelection) {
      draft.setAssetId("")
    }
    const searchId = ++latestSearchId.current
    setBusy(true)
    search(value.trim())
      .then((result) => {
        if (latestSearchId.current === searchId) {
          setCandidates(result.assets)
          // A recommended asset prefilled into the draft can be missing from
          // the search results, because the search runs on the observation's
          // display text. Keeping the hidden ID would enable preview with no
          // visible selection, so drop it when no candidate row can show it.
          if (
            !clearSelection &&
            draft.assetId.length > 0 &&
            !result.assets.some((asset) => asset.id === draft.assetId)
          ) {
            draft.setAssetId("")
          }
        }
      })
      .catch(() => {
        if (latestSearchId.current === searchId) {
          setCandidates([])
          // A failed search renders an empty candidate list; a preserved
          // prefilled ID would still enable preview with no visible pick.
          if (!clearSelection && draft.assetId.length > 0) {
            draft.setAssetId("")
          }
        }
      })
      .finally(() => {
        if (latestSearchId.current === searchId) {
          setBusy(false)
        }
      })
  }

  useEffect(() => {
    runSearch(initialQuery, false)
    // Initial search only — later searches are user-driven.
  }, [])

  const observed = observedRepresentation(draft.detail)
  const trustedCoinId = registryCoinId(draft.detail)
  const observationAddress = observed?.mintAddress ?? observed?.contractAddress ?? null
  const observedNetwork = observed?.blockchain.toLowerCase() ?? null
  const candidateState = (asset: AssetCatalogAsset) => {
    const networkRepresentations = asset.representations.filter(
      (representation) =>
        observedNetwork !== null && representation.blockchainName.toLowerCase() === observedNetwork
    )
    const sameIdentity = networkRepresentations.some(
      (representation) =>
        observationAddress !== null &&
        isSameAddress(
          representation.mintAddress ?? representation.contractAddress,
          observationAddress
        )
    )
    const registryMatch =
      trustedCoinId !== null &&
      asset.coingeckoCoinId !== null &&
      asset.coingeckoCoinId === trustedCoinId
    const conflictingNetworkIdentity =
      observedNetwork !== null && networkRepresentations.length > 0 && !sameIdentity
    return {
      conflictingNetworkIdentity,
      eligible: sameIdentity || registryMatch,
      networkRepresentations,
      registryMatch,
      sameIdentity,
    }
  }
  const attachmentUnavailable =
    candidates !== null && !busy && candidates.every((asset) => !candidateState(asset).eligible)

  useEffect(() => {
    draft.setAttachmentUnavailable(attachmentUnavailable)
  }, [attachmentUnavailable, draft.setAttachmentUnavailable])

  // The notice offers the safe alternatives but never replaces the search
  // controls: the right asset may match by address or a different name, or
  // the empty result may come from a transient search failure, so the
  // reviewer must always be able to refine or retry.
  const attachmentUnavailableNotice = (() => {
    if (!attachmentUnavailable || candidates === null) {
      return null
    }
    const conflictingAsset =
      candidates.find((asset) => candidateState(asset).conflictingNetworkIdentity) ?? candidates[0]
    const catalogRepresentation = conflictingAsset?.representations.find(
      (representation) => representation.blockchainName.toLowerCase() === observedNetwork
    )
    const catalogAddress =
      catalogRepresentation?.mintAddress ?? catalogRepresentation?.contractAddress ?? null
    const identityKind =
      observed?.mintAddress === null || observed?.mintAddress === undefined
        ? m["assetCatalog.exceptions.reviewUi.form.contract"]()
        : m["assetCatalog.exceptions.reviewUi.form.mint"]()

    return (
      <section
        aria-label={m["assetCatalog.exceptions.reviewUi.form.attachmentUnavailableLabel"]()}
        className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400"
          />
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">
              {m["assetCatalog.exceptions.reviewUi.form.noCompatibleAsset"]()}
            </h4>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {conflictingAsset === undefined
                ? m["assetCatalog.exceptions.reviewUi.form.noCatalogMatch"]()
                : m["assetCatalog.exceptions.reviewUi.form.identityConflict"]({
                    symbol: conflictingAsset.symbol,
                    network:
                      observed?.blockchain ?? m["assetCatalog.exceptions.reviewUi.form.network"](),
                    identityKind,
                  })}
            </p>
          </div>
        </div>

        {conflictingAsset === undefined ? null : (
          <dl className="mt-3 grid gap-2 rounded-lg border border-amber-500/20 bg-background/70 p-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">
                {m["assetCatalog.exceptions.reviewUi.form.observedIdentity"]({
                  identityKind,
                })}
              </dt>
              <dd className="mt-1 break-all font-mono text-xs font-medium">
                {observationAddress ?? m["assetCatalog.exceptions.reviewUi.form.notRecorded"]()}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">
                {m["assetCatalog.exceptions.reviewUi.form.catalogIdentity"]({
                  symbol: conflictingAsset.symbol,
                  identityKind,
                })}
              </dt>
              <dd className="mt-1 break-all font-mono text-xs font-medium">
                {catalogAddress ?? m["assetCatalog.exceptions.reviewUi.form.notRecorded"]()}
              </dd>
            </div>
          </dl>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => draft.setMode("new")} size="sm" type="button">
            {m["assetCatalog.exceptions.decision.newIdentity"]()}
          </Button>
          <Button
            onClick={() => draft.setMode("exclusion")}
            size="sm"
            type="button"
            variant="outline"
          >
            {m["assetCatalog.exceptions.decision.exclusion"]()}
          </Button>
        </div>
      </section>
    )
  })()

  return (
    <div className="grid gap-2">
      {attachmentUnavailableNotice}
      <FieldLabel error={claimError}>
        {m["assetCatalog.exceptions.reviewUi.form.whichAsset"]()} *
      </FieldLabel>
      <div className="flex gap-2">
        <Input
          aria-label={m["assetCatalog.exceptions.reviewUi.form.searchAssets"]()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              runSearch(query)
            }
          }}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={m["assetCatalog.exceptions.reviewUi.form.searchPlaceholder"]()}
          value={query}
        />
        <Button
          disabled={busy}
          onClick={() => runSearch(query)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Search data-icon="inline-start" />
          {m["assetCatalog.exceptions.reviewUi.form.search"]()}
        </Button>
      </div>
      {candidates === null ? (
        <p className="text-xs text-muted-foreground">
          {busy
            ? m["assetCatalog.exceptions.reviewUi.form.searching"]()
            : m["assetCatalog.exceptions.reviewUi.form.searchPrompt"]()}
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {m["assetCatalog.exceptions.reviewUi.form.noSearchResults"]()}
        </p>
      ) : (
        <div className="grid gap-2">
          <div className="grid gap-2" role="radiogroup">
            {candidates.map((asset) => {
              const selected = draft.assetId === asset.id
              const { conflictingNetworkIdentity, eligible, registryMatch, sameIdentity } =
                candidateState(asset)
              return (
                <button
                  aria-checked={selected}
                  aria-disabled={!eligible}
                  className={cn(
                    "rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                    !eligible
                      ? "cursor-not-allowed border-amber-500/30 bg-amber-500/5 opacity-80"
                      : selected
                        ? "border-primary bg-primary/5"
                        : "border-border [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/50"
                  )}
                  disabled={!eligible}
                  key={asset.id}
                  onClick={() => draft.setAssetId(selected ? "" : asset.id)}
                  role="radio"
                  type="button"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{asset.symbol}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {asset.name}
                    </span>
                    {asset.coingeckoCoinId === null ? null : (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <BadgeCheck aria-hidden="true" className="size-3.5" />
                        {m["assetCatalog.exceptions.reviewUi.form.coinGeckoListed"]()}
                      </span>
                    )}
                    {selected ? <Check aria-hidden="true" className="size-4 text-primary" /> : null}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {asset.representations.length === 0
                      ? m["assetCatalog.exceptions.reviewUi.form.noRepresentation"]()
                      : asset.representations
                          .map(
                            (representation) =>
                              `${representation.blockchainName} · ${
                                representation.mintAddress ??
                                representation.contractAddress ??
                                m["assetCatalog.exceptions.reviewUi.form.native"]()
                              } · ${m["assetCatalog.exceptions.reviewUi.form.decimals"]({ count: representation.decimals })}`
                          )
                          .join(" — ")}
                  </span>
                  {observationAddress === null ? null : (
                    <span
                      className={cn(
                        "mt-1 block text-xs",
                        sameIdentity
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-amber-700 dark:text-amber-400"
                      )}
                    >
                      {sameIdentity
                        ? m["assetCatalog.exceptions.reviewUi.form.exactIdentity"]()
                        : registryMatch
                          ? m["assetCatalog.exceptions.reviewUi.form.registryIdentity"]()
                          : conflictingNetworkIdentity
                            ? m["assetCatalog.exceptions.reviewUi.form.conflictingIdentity"]({
                                network:
                                  observed?.blockchain ??
                                  m["assetCatalog.exceptions.reviewUi.form.network"](),
                              })
                            : m["assetCatalog.exceptions.reviewUi.form.untrustedIdentity"]()}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {claimError === undefined ? null : <p className="text-xs text-destructive">{claimError}</p>}
    </div>
  )
}

/** Read-only network identity recorded with an attach or create decision. */
export function ObservedRepresentationSummary({ draft }: { readonly draft: DecisionDraft }) {
  if (draft.mode === "exclusion" || draft.mode === null) {
    return null
  }
  const observed = observedRepresentation(draft.detail)
  if (observed === null) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div>
          <p className="text-sm font-medium">
            {m["assetCatalog.exceptions.reviewUi.form.missingIdentityTitle"]()}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.form.missingIdentityDescription"]()}
          </p>
        </div>
      </div>
    )
  }
  const address = observed.mintAddress ?? observed.contractAddress
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start gap-2">
        <Database aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.form.representationTitle"]()}
          </p>
          <p className="mt-1 text-sm font-medium">
            {m["assetCatalog.exceptions.reviewUi.form.representationSummary"]({
              blockchain: observed.blockchain,
              type: observed.type,
              decimals: observed.decimals,
            })}
          </p>
          {address === null ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {m["assetCatalog.exceptions.reviewUi.form.nativeAsset"]()}
            </p>
          ) : (
            <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{address}</p>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.form.representationSource"]({
              provider: draft.detail.provider,
            })}
          </p>
        </div>
      </div>
    </div>
  )
}

export function RationaleField({ draft }: { readonly draft: DecisionDraft }) {
  const error = draft.fieldErrors.rationale

  if (draft.mode === "exclusion") {
    return (
      <details className="group rounded-lg border border-border" open={draft.rationale.length > 0}>
        <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground">
          {m["assetCatalog.exceptions.reviewUi.form.optionalNote"]()}
        </summary>
        <label className="grid gap-1 border-t border-border p-3">
          <FieldLabel>{m["assetCatalog.exceptions.reviewUi.form.additionalContext"]()}</FieldLabel>
          <Textarea
            aria-label={m["assetCatalog.exceptions.reviewUi.form.additionalNote"]()}
            className="min-h-20"
            onChange={(event) => draft.setRationale(event.currentTarget.value)}
            placeholder={m["assetCatalog.exceptions.reviewUi.form.notePlaceholder"]()}
            value={draft.rationale}
          />
        </label>
      </details>
    )
  }

  return (
    <label className="grid gap-1">
      <FieldLabel error={error}>{m["assetCatalog.exceptions.decision.rationale"]()} *</FieldLabel>
      <Textarea
        aria-invalid={error !== undefined}
        className="min-h-20"
        onChange={(event) => draft.setRationale(event.currentTarget.value)}
        placeholder={m["assetCatalog.exceptions.reviewUi.form.rationalePlaceholder"]()}
        value={draft.rationale}
      />
      {error === undefined ? null : <p className="text-xs text-destructive">{error}</p>}
    </label>
  )
}

function sourceUpdateSummary(sourceCount: number): string {
  if (sourceCount === 0) {
    return m["assetCatalog.exceptions.reviewUi.preview.noSources"]()
  }
  if (sourceCount === 1) {
    return m["assetCatalog.exceptions.reviewUi.preview.oneSource"]()
  }
  return m["assetCatalog.exceptions.reviewUi.preview.manySources"]({ count: sourceCount })
}

function representationDescription({
  draft,
  outcome,
}: {
  readonly draft: DecisionDraft
  readonly outcome: string
}): string | null {
  if (outcome === "none") {
    return null
  }
  const representation = observedRepresentation(draft.detail)
  const network = representation?.blockchain
  const networkName =
    network === undefined ? null : `${network.slice(0, 1).toUpperCase()}${network.slice(1)}`
  const label =
    networkName === null
      ? m["assetCatalog.exceptions.reviewUi.preview.networkRepresentation"]()
      : m["assetCatalog.exceptions.reviewUi.preview.namedRepresentation"]({
          network: networkName,
        })
  if (outcome === "create") {
    return m["assetCatalog.exceptions.reviewUi.preview.createRepresentation"]({
      representation: label,
    })
  }
  if (outcome === "reuse") {
    return m["assetCatalog.exceptions.reviewUi.preview.reuseRepresentation"]({
      representation: label,
    })
  }
  if (outcome === "reassign") {
    return m["assetCatalog.exceptions.reviewUi.preview.reassignRepresentation"]({
      representation: label,
    })
  }
  return null
}

/** Human-readable confirmation once a preview came back. */
export function PreviewCard({ draft }: { readonly draft: DecisionDraft }) {
  if (draft.preview === null) {
    return null
  }
  const { request, response } = draft.preview
  const isExclusion = request.claim._tag === "exclusion"
  const assetLabel =
    draft.symbol.trim().length === 0
      ? m["assetCatalog.exceptions.reviewUi.preview.observationFallback"]()
      : draft.symbol.trim()
  const requestedExclusionReason = request.claim._tag === "exclusion" ? request.claim.reason : null
  const exclusionReason =
    requestedExclusionReason === null
      ? undefined
      : EXCLUSION_REASONS.find((reason) => reason === requestedExclusionReason)
  const exclusionText =
    exclusionReason === undefined ? undefined : exclusionReasonText(exclusionReason)
  const title = isExclusion
    ? m["assetCatalog.exceptions.reviewUi.preview.excludeTitle"]({ asset: assetLabel })
    : response.assetOutcome === "create"
      ? m["assetCatalog.exceptions.reviewUi.preview.createTitle"]({ asset: assetLabel })
      : response.assetOutcome === "reuse"
        ? m["assetCatalog.exceptions.reviewUi.preview.attachTitle"]({ asset: assetLabel })
        : m["assetCatalog.exceptions.reviewUi.preview.applyTitle"]({ asset: assetLabel })
  const assetDescription = isExclusion
    ? m["assetCatalog.exceptions.reviewUi.preview.excludeDescription"]()
    : response.assetOutcome === "create"
      ? m["assetCatalog.exceptions.reviewUi.preview.createDescription"]()
      : response.assetOutcome === "reuse"
        ? m["assetCatalog.exceptions.reviewUi.preview.attachDescription"]()
        : m["assetCatalog.exceptions.reviewUi.preview.applyDescription"]()
  const networkDescription = representationDescription({
    draft,
    outcome: response.representationOutcome,
  })
  const revisionDescription =
    response.decisionAction === "supersession"
      ? m["assetCatalog.exceptions.reviewUi.preview.supersession"]()
      : response.decisionAction === "reversal"
        ? m["assetCatalog.exceptions.reviewUi.preview.reversal"]()
        : null
  const confirmLabel = isExclusion
    ? m["assetCatalog.exceptions.reviewUi.preview.confirmExclusion"]()
    : response.assetOutcome === "create"
      ? m["assetCatalog.exceptions.reviewUi.preview.confirmNewAsset"]()
      : response.assetOutcome === "reuse"
        ? m["assetCatalog.exceptions.reviewUi.preview.confirmAttachment"]()
        : m["assetCatalog.exceptions.reviewUi.preview.confirmDecision"]()

  return (
    <section
      aria-label={m["assetCatalog.exceptions.reviewUi.preview.regionLabel"]()}
      aria-live="polite"
      className="rounded-xl border border-primary/30 bg-primary/5 p-4"
    >
      <h4 className="text-sm font-semibold">{title}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{assetDescription}</p>
      {networkDescription === null ? null : (
        <p className="text-sm text-muted-foreground">{networkDescription}</p>
      )}
      {exclusionText === undefined ? null : (
        <div className="mt-3 rounded-lg border border-primary/20 bg-background/70 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.preview.reason"]()}
          </p>
          <p className="text-sm font-medium">{exclusionText.label}</p>
        </div>
      )}
      {revisionDescription === null ? null : (
        <p className="mt-3 text-xs text-muted-foreground">{revisionDescription}</p>
      )}
      <div className="mt-3 flex items-start gap-2 border-t border-primary/20 pt-3">
        <Database aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-5 text-muted-foreground">
          {sourceUpdateSummary(response.rematerializationSourceCount)}
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {/* Explicit type: inside the review form these would otherwise
            submit it and re-run the preview on every confirmation. */}
        <Button
          disabled={draft.busy}
          onClick={() => void draft.confirmDecision()}
          size="sm"
          type="button"
        >
          {confirmLabel}
        </Button>
        <Button
          disabled={draft.busy}
          onClick={draft.clearPreview}
          size="sm"
          type="button"
          variant="outline"
        >
          {m["assetCatalog.exceptions.reviewUi.preview.keepEditing"]()}
        </Button>
      </div>
    </section>
  )
}
