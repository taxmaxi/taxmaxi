/** State, parsing, and display helpers for asset exception review. */
import { AlertTriangle, Check, Copy } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  AssetExceptionDecisionInput,
  AssetExceptionDetail,
  AssetExceptionPreview,
} from "taxmaxi"
import { z } from "zod"

import type { AssetExceptionActions } from "#/components/asset-catalog-context"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

export type DraftMode = "existing" | "new" | "exclusion"

export type ExclusionReason =
  | "authority_banned"
  | "confirmed_spam"
  | "unsupported_asset_type"
  | "provider_artifact"

export type DraftMessage = {
  readonly kind: "error" | "success" | "info"
  readonly text: string
}

export type FieldErrors = {
  readonly claim?: string
  readonly rationale?: string
  readonly representation?: string
}

const EvidenceClaimSchema = z
  .object({
    _tag: z.string().optional(),
    authority: z.string().optional(),
    blockchain: z.string().optional(),
    coinId: z.string().optional(),
    contractAddress: z.string().nullable().optional(),
    decimals: z.number().optional(),
    mintAddress: z.string().nullable().optional(),
    name: z.string().optional(),
    symbol: z.string().optional(),
    type: z.string().optional(),
    verdict: z.enum(["verified", "unverified", "suspicious", "low_activity", "banned"]).optional(),
  })
  .passthrough()

const JupiterPayloadSchema = z
  .object({
    _tag: z.string().optional(),
    payload: z
      .array(
        z
          .object({
            audit: z
              .object({
                devBalancePercentage: z.number().optional(),
                isSus: z.boolean().optional(),
                topHoldersPercentage: z.number().optional(),
              })
              .passthrough()
              .optional(),
            holderCount: z.number().optional(),
            isVerified: z.boolean().optional(),
            liquidity: z.number().optional(),
            name: z.string().optional(),
            organicScoreLabel: z.string().optional(),
            symbol: z.string().optional(),
            tags: z.array(z.string()).optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough()

/* ── Detail loading (keeps stale detail visible while the next one loads) ── */

export function useAssetExceptionDetail(
  actions: AssetExceptionActions,
  exceptionRowId: string | undefined
) {
  const [detail, setDetail] = useState<AssetExceptionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const requestId = useRef(0)

  useEffect(() => {
    requestId.current += 1
    if (exceptionRowId === undefined) {
      setDetail(null)
      setLoading(false)
      setLoadError(null)
      return
    }
    const current = requestId.current
    setLoading(true)
    setLoadError(null)
    actions
      .get(exceptionRowId)
      .then((next) => {
        if (current === requestId.current) {
          setDetail(next)
        }
      })
      .catch(() => {
        if (current === requestId.current) {
          setDetail(null)
          setLoadError(m["assetCatalog.exceptions.errors.load"]())
        }
      })
      .finally(() => {
        if (current === requestId.current) {
          setLoading(false)
        }
      })
  }, [actions, exceptionRowId])

  return { detail, loadError, loading, setDetail }
}

/* ── Decision draft ── */

export const CONCLUSIONS: ReadonlyArray<{
  readonly mode: DraftMode
}> = [{ mode: "existing" }, { mode: "new" }, { mode: "exclusion" }]

export const EXCLUSION_REASONS: ReadonlyArray<ExclusionReason> = [
  "confirmed_spam",
  "authority_banned",
  "unsupported_asset_type",
  "provider_artifact",
]

export function exclusionReasonText(reason: ExclusionReason): {
  readonly label: string
  readonly description: string
} {
  switch (reason) {
    case "confirmed_spam":
      return {
        label: m["assetCatalog.exceptions.reviewUi.exclusion.spamLabel"](),
        description: m["assetCatalog.exceptions.reviewUi.exclusion.spamDescription"](),
      }
    case "authority_banned":
      return {
        label: m["assetCatalog.exceptions.reviewUi.exclusion.authorityLabel"](),
        description: m["assetCatalog.exceptions.reviewUi.exclusion.authorityDescription"](),
      }
    case "unsupported_asset_type":
      return {
        label: m["assetCatalog.exceptions.reviewUi.exclusion.unsupportedLabel"](),
        description: m["assetCatalog.exceptions.reviewUi.exclusion.unsupportedDescription"](),
      }
    case "provider_artifact":
      return {
        label: m["assetCatalog.exceptions.reviewUi.exclusion.artifactLabel"](),
        description: m["assetCatalog.exceptions.reviewUi.exclusion.artifactDescription"](),
      }
  }
}

export function availableExclusionReasons(
  detail: AssetExceptionDetail
): ReadonlyArray<ExclusionReason> {
  const policyReason = detail.policyOutput?.reason
  const hasBannedClaim = detail.evidence.some((evidence) => {
    const claim = EvidenceClaimSchema.safeParse(evidence.decodedClaim)
    return claim.success && claim.data.verdict === "banned"
  })

  return EXCLUSION_REASONS.filter((reason) => {
    switch (reason) {
      case "confirmed_spam":
        return true
      case "authority_banned":
        return hasBannedClaim
      case "unsupported_asset_type":
        return policyReason === "unsupported_representation_type"
      case "provider_artifact":
        return policyReason === "malformed_payload" || policyReason === "upstream_failure"
    }
  })
}

/** Map the policy reason to the conclusion an operator most likely wants. */
export function suggestedModeForReason(reason: string | null | undefined): DraftMode | null {
  switch (reason) {
    case "ownership_conflict":
    case "conflicting_evidence":
    case "non_exact_platform_match":
      return "existing"
    case "display_collision":
      return null
    case "spam_evidence":
      return "exclusion"
    case "authority_banned":
    case "unsupported_representation_type":
    case "malformed_payload":
      return "exclusion"
    default:
      return null
  }
}

function suggestedExclusionReason(reason: string | null | undefined): ExclusionReason {
  switch (reason) {
    case "authority_banned":
      return "authority_banned"
    case "unsupported_representation_type":
      return "unsupported_asset_type"
    case "malformed_payload":
      return "provider_artifact"
    default:
      return "confirmed_spam"
  }
}

export type ObservedRepresentation = {
  readonly blockchain: string
  readonly contractAddress: string | null
  readonly decimals: number
  readonly mintAddress: string | null
  readonly type: "native" | "token" | "nft"
}

export function observedRepresentation(
  detail: AssetExceptionDetail
): ObservedRepresentation | null {
  for (const evidence of detail.evidence) {
    if (evidence.claimKind !== "chain_fact") {
      continue
    }
    const claim = EvidenceClaimSchema.safeParse(evidence.decodedClaim)
    if (!claim.success) {
      continue
    }
    const { blockchain, contractAddress, decimals, mintAddress, type } = claim.data
    if (
      blockchain === undefined ||
      decimals === undefined ||
      (type !== "native" && type !== "token" && type !== "nft")
    ) {
      continue
    }
    return {
      blockchain,
      contractAddress: contractAddress ?? null,
      decimals,
      mintAddress: mintAddress ?? null,
      type,
    }
  }
  return null
}

/** CoinGecko identity proved by the current registry evidence, if one exists. */
export function registryCoinId(detail: AssetExceptionDetail): string | null {
  for (const evidence of detail.evidence) {
    if (evidence.authority !== "coingecko") {
      continue
    }
    const claim = EvidenceClaimSchema.safeParse(evidence.decodedClaim)
    if (claim.success && claim.data.coinId !== undefined) {
      return claim.data.coinId
    }
  }
  return null
}

export type DecisionDraft = ReturnType<typeof useDecisionDraft>

export function useDecisionDraft({
  actions,
  detail,
  onDetailChange,
}: {
  readonly actions: AssetExceptionActions
  readonly detail: AssetExceptionDetail
  readonly onDetailChange: (detail: AssetExceptionDetail) => void
}) {
  const policyReason = detail.policyOutput?.reason ?? null
  const activeAssetId = detail.activeDecision?.assetId ?? ""
  const observed = observedRepresentation(detail)
  const suggestedMode = activeAssetId.length > 0 ? "existing" : suggestedModeForReason(policyReason)

  const [mode, setModeState] = useState<DraftMode | null>(suggestedMode)
  const [assetId, setAssetId] = useState(activeAssetId)
  const [name, setName] = useState(detail.name ?? "")
  const [symbol, setSymbol] = useState(detail.currencyCode)
  const [assetType, setAssetType] = useState<"fungible" | "nft">("fungible")
  const [blockchain, setBlockchain] = useState(observed?.blockchain ?? "")
  const [representationType, setRepresentationType] = useState<"native" | "token" | "nft">(
    observed?.type ?? "token"
  )
  const [address, setAddress] = useState(observed?.mintAddress ?? observed?.contractAddress ?? "")
  const [addressKind, setAddressKind] = useState<"contract" | "mint">(
    observed?.mintAddress === null || observed?.mintAddress === undefined ? "contract" : "mint"
  )
  const [decimals, setDecimals] = useState(observed === null ? "" : observed.decimals.toString())
  const [exclusionReason, setExclusionReason] = useState<ExclusionReason>(
    suggestedExclusionReason(policyReason)
  )
  const [rationale, setRationale] = useState("")
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [attachmentUnavailable, setAttachmentUnavailable] = useState(false)
  const [preview, setPreview] = useState<{
    readonly request: AssetExceptionDecisionInput
    readonly response: AssetExceptionPreview
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<DraftMessage | null>(null)

  const setMode = (next: DraftMode | null) => {
    setModeState(next)
    setPreview(null)
    setFieldErrors({})
    setMessage(null)
  }

  const makeRequest = (): AssetExceptionDecisionInput | null => {
    const errors: {
      claim?: string
      rationale?: string
      representation?: string
    } = {}
    const trimmedRationale = rationale.trim()
    if (mode === null) {
      errors.claim = m["assetCatalog.exceptions.reviewUi.errors.selectResolution"]()
    }
    if (mode !== "exclusion" && trimmedRationale.length === 0) {
      errors.rationale = m["assetCatalog.exceptions.reviewUi.errors.rationaleRequired"]()
    }

    const representation = (() => {
      if (mode === "exclusion" || mode === null) {
        return null
      }
      const trimmedBlockchain = blockchain.trim()
      const trimmedAddress = address.trim()
      if (
        trimmedBlockchain.length === 0 &&
        trimmedAddress.length === 0 &&
        decimals.trim().length === 0
      ) {
        return null
      }
      const decimalCount = Number(decimals)
      if (
        !Number.isInteger(decimalCount) ||
        decimalCount < 0 ||
        trimmedBlockchain.length === 0 ||
        (representationType === "native" && trimmedAddress.length > 0) ||
        (representationType !== "native" && trimmedAddress.length === 0)
      ) {
        errors.representation =
          m["assetCatalog.exceptions.reviewUi.errors.representationRequired"]()
        return null
      }
      return {
        blockchain: trimmedBlockchain,
        type: representationType,
        contractAddress:
          representationType !== "native" && addressKind === "contract" ? trimmedAddress : null,
        mintAddress:
          representationType !== "native" && addressKind === "mint" ? trimmedAddress : null,
        decimals: decimalCount,
      }
    })()

    const claim = (() => {
      switch (mode) {
        case null:
          return null
        case "exclusion":
          return { _tag: "exclusion" as const, reason: exclusionReason }
        case "existing":
          if (assetId.trim().length === 0) {
            errors.claim = m["assetCatalog.exceptions.reviewUi.errors.chooseAsset"]()
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
            errors.claim = m["assetCatalog.exceptions.reviewUi.errors.newAssetRequired"]()
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

    setFieldErrors(errors)
    if (claim === null || Object.keys(errors).length > 0) {
      return null
    }
    return {
      id: detail.providerAssetRowId,
      claim,
      evidenceRevision: detail.evidenceRevision,
      activeDecisionRevision: detail.activeDecisionRevision,
      // All current snapshots are linked to the decision — the full picture
      // (including "authority had no claim") is what the reviewer judged.
      evidenceSnapshotIds: detail.evidence.map((evidence) => evidence.id),
      rationale: trimmedRationale.length === 0 ? null : trimmedRationale,
    }
  }

  const previewDecision = async () => {
    const request = makeRequest()
    if (request === null) {
      setMessage({
        kind: "error",
        text: m["assetCatalog.exceptions.reviewUi.errors.fixFields"](),
      })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      setPreview({ request, response: await actions.preview(request) })
    } catch {
      setMessage({ kind: "error", text: m["assetCatalog.exceptions.reviewUi.errors.preview"]() })
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
      setMessage({ kind: "success", text: m["assetCatalog.exceptions.success"]() })
    } catch {
      setMessage({
        kind: "error",
        text: m["assetCatalog.exceptions.reviewUi.errors.submit"](),
      })
    } finally {
      setBusy(false)
    }
  }

  const canPreview = (() => {
    if (busy || preview !== null || detail.evidence.length === 0) {
      return false
    }
    switch (mode) {
      case null:
        return false
      case "exclusion":
        return true
      case "existing":
        return (
          assetId.trim().length > 0 &&
          rationale.trim().length > 0 &&
          (detail.provider !== "helius-solana" || observed !== null)
        )
      case "new":
        return (
          name.trim().length > 0 &&
          symbol.trim().length > 0 &&
          rationale.trim().length > 0 &&
          (detail.provider !== "helius-solana" || observed !== null)
        )
    }
  })()

  return {
    address,
    addressKind,
    assetId,
    assetType,
    attachmentUnavailable,
    blockchain,
    busy,
    canPreview,
    clearPreview: () => setPreview(null),
    confirmDecision,
    decimals,
    detail,
    exclusionReason,
    fieldErrors,
    message,
    mode,
    name,
    preview,
    previewDecision,
    rationale,
    representationType,
    searchAssets: actions.searchAssets,
    setAddress,
    setAddressKind,
    setAssetId,
    setAssetType,
    setAttachmentUnavailable,
    setBlockchain,
    setDecimals,
    setExclusionReason,
    setMode,
    setName,
    setRationale,
    setRepresentationType,
    setSymbol,
    suggestedMode,
    symbol,
  }
}

/* ── Formatting ── */

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof value === "object" && value !== null && "epochMilliseconds" in value) {
    const millis = (value as { readonly epochMilliseconds: unknown }).epochMilliseconds
    if (typeof millis === "number") {
      return new Date(millis)
    }
  }
  return null
}

export function formatWhen(value: unknown): string | null {
  const date = toDate(value)
  if (date === null) {
    return null
  }
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export function formatAgo(value: unknown): string | null {
  const date = toDate(value)
  if (date === null) {
    return null
  }
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 3600) {
    return m["assetCatalog.exceptions.reviewUi.minutesAgo"]({
      count: Math.max(1, Math.round(seconds / 60)),
    })
  }
  if (seconds < 86_400) {
    return m["assetCatalog.exceptions.reviewUi.hoursAgo"]({
      count: Math.round(seconds / 3600),
    })
  }
  return m["assetCatalog.exceptions.reviewUi.daysAgo"]({
    count: Math.round(seconds / 86_400),
  })
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null"
  } catch {
    return m["assetCatalog.exceptions.evidence.unavailable"]()
  }
}

/* ── Plain-English labels ── */

export function reasonText(reason: string | null | undefined): string {
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
    case "unverified_asset":
      return m["assetCatalog.exceptions.labels.reason.unverifiedAsset"]()
    case "authority_banned":
      return m["assetCatalog.exceptions.exclusion.authorityBanned"]()
    case "confirmed_spam":
      return m["assetCatalog.exceptions.reviewUi.exclusion.spamLabel"]()
    case "unsupported_asset_type":
      return m["assetCatalog.exceptions.exclusion.unsupportedAssetType"]()
    case "provider_artifact":
      return m["assetCatalog.exceptions.reviewUi.exclusion.artifactLabel"]()
    case "manual_exclusion_reversal":
      return m["assetCatalog.exceptions.labels.reason.manualExclusionReversal"]()
    default:
      return m["assetCatalog.exceptions.unknown"]()
  }
}

export function outcomeText(outcome: string): string {
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
    default:
      return m["assetCatalog.exceptions.unknown"]()
  }
}

export function claimKindText(claimKind: string): string {
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

/* ── Status tints ── */

export function statusClasses(status: "unresolved" | "approved" | "excluded"): string {
  switch (status) {
    case "unresolved":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    case "approved":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    case "excluded":
      return "border-border bg-muted text-muted-foreground"
  }
}

export function statusText(status: "unresolved" | "approved" | "excluded"): string {
  switch (status) {
    case "unresolved":
      return m["assetCatalog.exceptions.review.unresolved"]()
    case "approved":
      return m["assetCatalog.exceptions.review.approved"]()
    case "excluded":
      return m["assetCatalog.exceptions.review.excluded"]()
  }
}

export function TintBadge({
  children,
  className,
}: {
  readonly children: React.ReactNode
  readonly className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        className
      )}
    >
      {children}
    </span>
  )
}

/* ── Copyable identifiers ── */

export function CopyText({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      className="group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      title={m["assetCatalog.exceptions.reviewUi.technical.copy"]({ label })}
      type="button"
    >
      <span className="truncate font-mono text-xs">{value}</span>
      {copied ? (
        <Check aria-hidden="true" className="size-3 shrink-0 text-emerald-600" />
      ) : (
        <Copy
          aria-hidden="true"
          className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      )}
      <span className="sr-only">
        {m["assetCatalog.exceptions.reviewUi.technical.copy"]({ label })}
      </span>
    </button>
  )
}

/* ── Message line (errors look like errors) ── */

export function MessageLine({ message }: { readonly message: DraftMessage | null }) {
  if (message === null) {
    return null
  }
  return (
    <p
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        message.kind === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : message.kind === "success"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "border-border bg-muted text-muted-foreground"
      )}
      role={message.kind === "error" ? "alert" : "status"}
    >
      {message.text}
    </p>
  )
}

/* ── Case explainer: why is this on my table, and what do I do? ── */

/** Plain-English answer to "why is this here and what should I do about it". */
export function caseExplainer(detail: AssetExceptionDetail): string {
  const symbol = detail.currencyCode
  switch (detail.policyOutput?.reason) {
    case "display_collision":
      return m["assetCatalog.exceptions.reviewUi.case.displayCollision"]({ symbol })
    case "ownership_conflict":
      return m["assetCatalog.exceptions.reviewUi.case.ownershipConflict"]()
    case "conflicting_evidence":
      return m["assetCatalog.exceptions.reviewUi.case.conflictingEvidence"]({ symbol })
    case "non_exact_platform_match":
      return m["assetCatalog.exceptions.reviewUi.case.nonExactPlatformMatch"]()
    case "spam_evidence":
      return m["assetCatalog.exceptions.reviewUi.case.spamEvidence"]({ symbol })
    case "incompatible_decimals":
      return m["assetCatalog.exceptions.reviewUi.case.incompatibleDecimals"]()
    case "incompatible_type":
      return m["assetCatalog.exceptions.reviewUi.case.incompatibleType"]()
    case "unsupported_representation_type":
      return m["assetCatalog.exceptions.reviewUi.case.unsupportedRepresentation"]()
    case "malformed_payload":
      return m["assetCatalog.exceptions.reviewUi.case.malformedPayload"]()
    case "upstream_failure":
      return m["assetCatalog.exceptions.reviewUi.case.upstreamFailure"]()
    default:
      return m["assetCatalog.exceptions.reviewUi.case.default"]()
  }
}

type EvidenceTone = "danger" | "positive" | "warning" | "neutral"

export type EvidenceSummary = {
  readonly detail: string
  readonly label: string
  readonly tone: EvidenceTone
}

function percent(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`
}

export function summarizeEvidence(
  evidence: AssetExceptionDetail["evidence"][number]
): EvidenceSummary {
  const claim = EvidenceClaimSchema.safeParse(evidence.decodedClaim)

  if (evidence.authority === "chain" && claim.success) {
    const address = claim.data.mintAddress ?? claim.data.contractAddress
    const addressText =
      address === null || address === undefined
        ? m["assetCatalog.exceptions.reviewUi.evidenceSummary.nativeAsset"]()
        : address
    return {
      detail: m["assetCatalog.exceptions.reviewUi.evidenceSummary.chainDetail"]({
        blockchain:
          claim.data.blockchain ?? m["assetCatalog.exceptions.reviewUi.evidenceSummary.network"](),
        type: claim.data.type ?? m["assetCatalog.exceptions.reviewUi.evidenceSummary.asset"](),
        decimals: claim.data.decimals ?? "?",
        address: addressText,
      }),
      label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.chainLabel"](),
      tone: "neutral",
    }
  }

  if (evidence.authority === "coingecko") {
    if (claim.success && claim.data.coinId !== undefined) {
      return {
        detail: m["assetCatalog.exceptions.reviewUi.evidenceSummary.registryMatch"]({
          name: claim.data.name ?? claim.data.symbol ?? claim.data.coinId,
          coinId: claim.data.coinId,
        }),
        label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.registryMatchLabel"](),
        tone: "positive",
      }
    }
    return {
      detail: m["assetCatalog.exceptions.reviewUi.evidenceSummary.noRegistryMatch"](),
      label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.noRegistryMatchLabel"](),
      tone: "warning",
    }
  }

  if (evidence.authority === "jupiter") {
    const raw = JupiterPayloadSchema.safeParse(evidence.rawPayload)
    const token = raw.success ? raw.data.payload?.[0] : undefined
    const details: Array<string> = []
    if (token?.tags?.includes("duplicate") === true) {
      details.push(m["assetCatalog.exceptions.reviewUi.evidenceSummary.duplicate"]())
    }
    if (token?.audit?.topHoldersPercentage !== undefined) {
      details.push(
        m["assetCatalog.exceptions.reviewUi.evidenceSummary.topHolders"]({
          percent: percent(token.audit.topHoldersPercentage),
        })
      )
    }
    if (token?.audit?.devBalancePercentage !== undefined) {
      details.push(
        m["assetCatalog.exceptions.reviewUi.evidenceSummary.developerHolding"]({
          percent: percent(token.audit.devBalancePercentage),
        })
      )
    }
    if (token?.holderCount !== undefined) {
      details.push(
        m["assetCatalog.exceptions.reviewUi.evidenceSummary.holders"]({
          count: token.holderCount.toLocaleString(),
        })
      )
    }
    if (token?.liquidity !== undefined) {
      details.push(
        m["assetCatalog.exceptions.reviewUi.evidenceSummary.liquidity"]({
          amount: Math.round(token.liquidity).toLocaleString(),
        })
      )
    }

    const verdict = claim.success ? claim.data.verdict : undefined
    switch (verdict) {
      case "banned":
        return {
          detail:
            details.length === 0
              ? m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterBanned"]()
              : details.join(" · "),
          label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterBannedLabel"](),
          tone: "danger",
        }
      case "suspicious":
        return {
          detail:
            details.length === 0
              ? m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterSuspicious"]()
              : details.join(" · "),
          label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterSuspiciousLabel"](),
          tone: "danger",
        }
      case "verified":
        return {
          detail:
            details.length === 0
              ? m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterVerified"]()
              : details.join(" · "),
          label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterVerifiedLabel"](),
          tone: "positive",
        }
      case "low_activity":
        return {
          detail:
            details.length === 0
              ? m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterLowActivity"]()
              : details.join(" · "),
          label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterLowActivityLabel"](),
          tone: "warning",
        }
      case "unverified":
        return {
          detail:
            details.length === 0
              ? m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterUnverified"]()
              : details.join(" · "),
          label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.jupiterUnverifiedLabel"](),
          tone: "warning",
        }
      case undefined:
        return {
          detail: m["assetCatalog.exceptions.reviewUi.evidenceSummary.noJupiterRecord"](),
          label: m["assetCatalog.exceptions.reviewUi.evidenceSummary.noJupiterRecordLabel"](),
          tone: "warning",
        }
    }
  }

  return {
    detail:
      evidence.decodedClaim === null || evidence.decodedClaim === undefined
        ? m["assetCatalog.exceptions.reviewUi.evidenceSummary.noClaim"]()
        : m["assetCatalog.exceptions.reviewUi.evidenceSummary.rawClaim"](),
    label: claimKindText(evidence.claimKind),
    tone: "neutral",
  }
}

function recommendationText(detail: AssetExceptionDetail): {
  readonly action: string
  readonly explanation: string
  readonly tone: "danger" | "neutral" | "warning"
} {
  switch (detail.policyOutput?.reason) {
    case "spam_evidence":
      return {
        action: m["assetCatalog.exceptions.reviewUi.case.recommendSpam"](),
        explanation: m["assetCatalog.exceptions.reviewUi.case.recommendSpamDescription"](),
        tone: "danger",
      }
    case "display_collision":
      return {
        action: m["assetCatalog.exceptions.reviewUi.case.recommendCollision"](),
        explanation: m["assetCatalog.exceptions.reviewUi.case.recommendCollisionDescription"](),
        tone: "warning",
      }
    case "unsupported_representation_type":
      return {
        action: m["assetCatalog.exceptions.reviewUi.case.recommendUnsupported"](),
        explanation: m["assetCatalog.exceptions.reviewUi.case.recommendUnsupportedDescription"](),
        tone: "warning",
      }
    default:
      return {
        action: m["assetCatalog.exceptions.reviewUi.case.recommendDefault"](),
        explanation: m["assetCatalog.exceptions.reviewUi.case.recommendDefaultDescription"](),
        tone: "neutral",
      }
  }
}

export function CaseBrief({ detail }: { readonly detail: AssetExceptionDetail }) {
  const recommendation = recommendationText(detail)
  return (
    <section className="grid gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400"
        />
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold">
            {m["assetCatalog.exceptions.reviewUi.case.title"]()}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">{caseExplainer(detail)}</p>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-background/80 px-3 py-2">
        <p className="text-sm font-medium">{recommendation.action}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {recommendation.explanation}
        </p>
      </div>
    </section>
  )
}

/** Friendly name for decision actors ("system:*" ids are machine actors). */
export function actorText(actorId: string): string {
  if (actorId === "system:asset-resolution-policy") {
    return m["assetCatalog.exceptions.reviewUi.automaticPolicy"]()
  }
  return actorId.startsWith("system:")
    ? m["assetCatalog.exceptions.reviewUi.systemActor"]({
        actor: actorId.slice("system:".length),
      })
    : actorId
}

/* ── Technical IDs, demoted and explained ── */

export function TechnicalIds({ detail }: { readonly detail: AssetExceptionDetail }) {
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground">
        {m["assetCatalog.exceptions.reviewUi.technical.title"]()}
      </summary>
      <div className="grid gap-2 border-t border-border p-3 text-xs">
        <p className="text-muted-foreground">
          {m["assetCatalog.exceptions.reviewUi.technical.description"]()}
        </p>
        {detail.providerAssetId === null ? null : (
          <div className="grid gap-0.5">
            <span className="text-muted-foreground">
              {m["assetCatalog.exceptions.reviewUi.technical.providerId"]()}
            </span>
            <CopyText
              label={m["assetCatalog.exceptions.reviewUi.technical.observationId"]()}
              value={detail.providerAssetId}
            />
          </div>
        )}
        {detail.naturalKey === null ? null : (
          <div className="grid gap-0.5">
            <span className="text-muted-foreground">
              {m["assetCatalog.exceptions.reviewUi.technical.stableKey"]()}
            </span>
            <CopyText
              label={m["assetCatalog.exceptions.reviewUi.technical.naturalKey"]()}
              value={detail.naturalKey}
            />
          </div>
        )}
        <div className="grid gap-0.5">
          <span className="text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.technical.evidenceRevision"]()}
          </span>
          <span className="font-mono">{detail.evidenceRevision}</span>
        </div>
        <div className="grid gap-0.5">
          <span className="text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.technical.policyRevision"]()}
          </span>
          <CopyText
            label={m["assetCatalog.exceptions.reviewUi.technical.policyRevisionLabel"]()}
            value={detail.policyRevision}
          />
        </div>
      </div>
    </details>
  )
}

/* ── Openable snapshot references in decision history ── */

export function SnapshotRefs({
  evidence,
  ids,
}: {
  readonly evidence: AssetExceptionDetail["evidence"]
  readonly ids: ReadonlyArray<string>
}) {
  if (ids.length === 0) {
    return (
      <span className="text-muted-foreground">
        {m["assetCatalog.exceptions.reviewUi.technical.noEvidence"]()}
      </span>
    )
  }
  return (
    <details>
      <summary className="cursor-pointer select-none text-muted-foreground">
        {ids.length === 1
          ? m["assetCatalog.exceptions.reviewUi.technical.linkedEvidence"]({
              count: ids.length,
            })
          : m["assetCatalog.exceptions.reviewUi.technical.linkedEvidences"]({
              count: ids.length,
            })}
      </summary>
      <div className="mt-2 grid gap-2">
        {ids.map((id) => {
          const match = evidence.find((snapshot) => snapshot.id === id)
          if (match === undefined) {
            return (
              <p className="text-muted-foreground" key={id}>
                {m["assetCatalog.exceptions.reviewUi.technical.oldSnapshot"]()}
              </p>
            )
          }
          const when = formatWhen(match.retrievedAt)
          return (
            <div className="rounded-lg border border-border p-2" key={id}>
              <p>
                <span className="font-medium">{match.authority}</span>{" "}
                <span className="text-muted-foreground">
                  {claimKindText(match.claimKind)}
                  {when === null ? null : ` · ${when}`}
                </span>
              </p>
              {match.decodedClaim === null || match.decodedClaim === undefined ? (
                <p className="mt-1 italic text-muted-foreground">
                  {m["assetCatalog.exceptions.reviewUi.technical.noClaim"]()}
                </p>
              ) : (
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono">
                  {formatJson(match.decodedClaim)}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </details>
  )
}

/* ── Impact summary ── */

export function impactParts(detail: AssetExceptionDetail): ReadonlyArray<string> {
  const impact = detail.impact
  return [
    impact.blockedReports === 1
      ? m["assetCatalog.exceptions.reviewUi.impact.blockedReport"]({
          count: impact.blockedReports,
        })
      : m["assetCatalog.exceptions.reviewUi.impact.blockedReports"]({
          count: impact.blockedReports,
        }),
    impact.affectedPrincipals === 1
      ? m["assetCatalog.exceptions.reviewUi.impact.principal"]({
          count: impact.affectedPrincipals,
        })
      : m["assetCatalog.exceptions.reviewUi.impact.principals"]({
          count: impact.affectedPrincipals,
        }),
    impact.affectedTransactions === 1
      ? m["assetCatalog.exceptions.reviewUi.impact.transaction"]({
          count: impact.affectedTransactions,
        })
      : m["assetCatalog.exceptions.reviewUi.impact.transactions"]({
          count: impact.affectedTransactions,
        }),
    impact.affectedSources === 1
      ? m["assetCatalog.exceptions.reviewUi.impact.source"]({
          count: impact.affectedSources,
        })
      : m["assetCatalog.exceptions.reviewUi.impact.sources"]({
          count: impact.affectedSources,
        }),
    impact.affectedTransactionValueEur === null
      ? m["assetCatalog.exceptions.reviewUi.impact.unknownValue"]()
      : m["assetCatalog.exceptions.reviewUi.impact.eurValue"]({
          value: impact.affectedTransactionValueEur,
        }),
  ]
}
