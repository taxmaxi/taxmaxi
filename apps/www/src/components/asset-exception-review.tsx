/** The chronological review surface for one asset exception. */
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileInput,
  Gavel,
  History,
  RefreshCw,
  Sparkles,
} from "lucide-react"
import type { ReactNode } from "react"

import type { AssetExceptionActions } from "#/components/asset-catalog-context"
import type { TaxMaxiAssetException } from "#/components/asset-catalog-model"
import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"
import type { AssetExceptionDetail } from "taxmaxi"

import {
  ClaimFields,
  ObservedRepresentationSummary,
  PreviewCard,
  RationaleField,
} from "./asset-exception-decision-fields"
import {
  actorText,
  CaseBrief,
  CONCLUSIONS,
  formatAgo,
  formatJson,
  formatWhen,
  impactParts,
  MessageLine,
  outcomeText,
  reasonText,
  SnapshotRefs,
  statusClasses,
  statusText,
  summarizeEvidence,
  TechnicalIds,
  TintBadge,
  useDecisionDraft,
} from "./asset-exception-review-support"

export function AssetExceptionReview({
  actions,
  detail,
  exception,
  onDetailChange,
  stale,
}: {
  readonly actions: AssetExceptionActions
  readonly detail: AssetExceptionDetail
  readonly exception?: TaxMaxiAssetException
  readonly onDetailChange: (detail: AssetExceptionDetail) => void
  readonly stale: boolean
}) {
  const draft = useDecisionDraft({ actions, detail, onDetailChange })
  const age = exception === undefined ? null : formatAgo(exception.oldestAt)
  const hasHumanDecision = detail.decisionHistory.some((decision) => decision.claim !== null)
  const showDataUpdate = hasHumanDecision && detail.rematerialization.affectedSourceCount > 0

  return (
    <div
      className={cn(
        "mx-auto flex max-w-4xl flex-col gap-5 font-interface transition-opacity",
        stale ? "pointer-events-none opacity-50" : ""
      )}
    >
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-3xl font-semibold tracking-tight">{detail.currencyCode}</h2>
          <TintBadge className={statusClasses(detail.reviewStatus)}>
            {detail.reviewStatus === "unresolved"
              ? m["assetCatalog.exceptions.reviewUi.needsDecision"]()
              : statusText(detail.reviewStatus)}
          </TintBadge>
          {exception === undefined ? null : (
            <TintBadge className="border-border bg-muted text-muted-foreground">
              {reasonText(exception.reason)}
            </TintBadge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {detail.name ?? m["assetCatalog.exceptions.reviewUi.noName"]()} · {detail.provider}
          {age === null ? null : <> · {m["assetCatalog.exceptions.reviewUi.caseOpen"]({ age })}</>}
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-6">
          {m["assetCatalog.exceptions.reviewUi.intro"]()}
        </p>
      </header>

      <CaseBrief detail={detail} />

      <section
        aria-label={m["assetCatalog.exceptions.reviewUi.timelineLabel"]()}
        className="relative ml-4 border-l border-border pl-8"
      >
        <TimelineEvent
          icon={<FileInput aria-hidden="true" />}
          meta={
            age === null
              ? m["assetCatalog.exceptions.reviewUi.firstObservation"]()
              : m["assetCatalog.exceptions.reviewUi.firstObserved"]({ age })
          }
          title={m["assetCatalog.exceptions.reviewUi.observationTitle"]()}
        >
          <p className="text-sm text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.observationDescription"]({
              provider: detail.provider,
              symbol: detail.currencyCode,
              name: detail.name ?? m["assetCatalog.exceptions.reviewUi.unnamedAsset"](),
            })}
          </p>
          <div className="mt-2 max-w-md">
            <TechnicalIds detail={detail} />
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {m["assetCatalog.exceptions.reviewUi.rawProviderPayload"]()}
            </summary>
            <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
              {formatJson(detail.rawProviderPayload)}
            </pre>
          </details>
        </TimelineEvent>

        {detail.evidence.map((evidence) => {
          const summary = summarizeEvidence(evidence)
          const chainEvidence = evidence.authority === "chain"
          return (
            <TimelineEvent
              icon={<Database aria-hidden="true" />}
              key={evidence.id}
              meta={formatWhen(evidence.retrievedAt)}
              tone={
                summary.tone === "danger"
                  ? "danger"
                  : summary.tone === "positive"
                    ? "success"
                    : summary.tone === "warning"
                      ? "warning"
                      : "neutral"
              }
              title={summary.label}
            >
              <div className="min-w-0 text-sm">
                <span className="text-muted-foreground">{summary.detail}</span>
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {m["assetCatalog.exceptions.reviewUi.technicalEvidence"]()}
                  </summary>
                  {chainEvidence ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {m["assetCatalog.exceptions.reviewUi.chainEvidenceDescription"]({
                        provider: detail.provider,
                      })}
                    </p>
                  ) : null}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-xs font-medium">
                        {chainEvidence
                          ? m["assetCatalog.exceptions.reviewUi.policyInput"]()
                          : m["assetCatalog.exceptions.reviewUi.claimUsedByPolicy"]()}
                      </p>
                      <pre className="max-h-52 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
                        {formatJson(evidence.decodedClaim)}
                      </pre>
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-medium">
                        {chainEvidence
                          ? m["assetCatalog.exceptions.reviewUi.recordedTransferObservations"]()
                          : m["assetCatalog.exceptions.reviewUi.sourceResponse"]()}
                      </p>
                      <pre className="max-h-52 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
                        {formatJson(evidence.rawPayload)}
                      </pre>
                    </div>
                  </div>
                </details>
              </div>
            </TimelineEvent>
          )
        })}

        {detail.decisionHistory.map((decision) => {
          const automatic = decision.actorId === "system:asset-resolution-policy"
          const reviewRequest =
            automatic && (decision.outcome === "pending" || decision.outcome === "fail_closed")
          const when = formatWhen(decision.createdAt)
          return (
            <TimelineEvent
              icon={automatic ? <Gavel aria-hidden="true" /> : <History aria-hidden="true" />}
              key={decision.id}
              meta={
                when === null
                  ? actorText(decision.actorId)
                  : `${when} · ${actorText(decision.actorId)}`
              }
              tone={
                reviewRequest ? "warning" : decision.isCurrentConclusion ? "success" : "neutral"
              }
              title={
                reviewRequest
                  ? m["assetCatalog.exceptions.reviewUi.reviewRequested"]()
                  : outcomeText(decision.outcome)
              }
            >
              <p className="text-sm">
                {decision.rationale ??
                  (decision.reason === null
                    ? m["assetCatalog.exceptions.reviewUi.noAdditionalNote"]()
                    : reasonText(decision.reason))}
              </p>
              {reviewRequest ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {impactParts(detail).join(" · ")}
                </p>
              ) : decision.evidenceSnapshotIds.length === 0 ? null : (
                <div className="mt-1 text-xs">
                  <SnapshotRefs evidence={detail.evidence} ids={decision.evidenceSnapshotIds} />
                </div>
              )}
            </TimelineEvent>
          )
        })}

        {showDataUpdate ? <DataUpdateEvent detail={detail} /> : null}
      </section>

      <section className="ml-4 rounded-2xl border border-primary/30 bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-medium">
              {m["assetCatalog.exceptions.reviewUi.composerTitle"]()}
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {m["assetCatalog.exceptions.reviewUi.evidenceLinked"]({
                count: detail.evidence.length,
              })}
            </p>
          </div>
          {draft.suggestedMode === null ? null : (
            <span className="flex items-center gap-1 text-xs text-primary">
              <Sparkles aria-hidden="true" className="size-3.5" />
              {m["assetCatalog.exceptions.reviewUi.suggestionAvailable"]()}
            </span>
          )}
        </div>

        {draft.attachmentUnavailable && draft.mode === "existing" ? null : (
          <div
            aria-label={m["assetCatalog.exceptions.reviewUi.conclusionLabel"]()}
            className="mt-4 grid gap-2 sm:grid-cols-3"
            role="radiogroup"
          >
            {CONCLUSIONS.map((conclusion) => {
              const unavailable = conclusion.mode === "existing" && draft.attachmentUnavailable
              const selected = draft.mode === conclusion.mode && !unavailable
              return (
                <button
                  aria-checked={selected}
                  aria-disabled={unavailable}
                  className={cn(
                    "min-h-12 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-[background-color,border-color] focus-visible:ring-3 focus-visible:ring-ring/30",
                    unavailable
                      ? "cursor-not-allowed border-border bg-muted/50 text-muted-foreground"
                      : selected
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/50"
                  )}
                  disabled={unavailable}
                  key={conclusion.mode}
                  onClick={() => draft.setMode(conclusion.mode)}
                  role="radio"
                  type="button"
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    {conclusionTitle(conclusion.mode)}
                    {unavailable ? (
                      <span className="ml-auto text-xs font-normal">
                        {m["assetCatalog.exceptions.reviewUi.unavailable"]()}
                      </span>
                    ) : draft.suggestedMode === conclusion.mode ? (
                      <Sparkles
                        aria-label={m["assetCatalog.exceptions.reviewUi.suggested"]()}
                        className="ml-auto size-3.5 text-primary"
                      />
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {draft.mode === null ? null : (
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void draft.previewDecision()
            }}
          >
            <fieldset className="grid gap-3" disabled={draft.busy || draft.preview !== null}>
              <ClaimFields draft={draft} />
              {draft.mode === "existing" && draft.attachmentUnavailable ? null : (
                <>
                  <ObservedRepresentationSummary draft={draft} />
                  <RationaleField draft={draft} />
                </>
              )}
            </fieldset>
            {draft.mode === "existing" && draft.attachmentUnavailable ? null : (
              <>
                <MessageLine message={draft.message} />
                {draft.preview === null ? (
                  <Button
                    className="h-11 justify-self-start"
                    disabled={!draft.canPreview}
                    type="submit"
                  >
                    {draft.busy
                      ? m["assetCatalog.exceptions.reviewUi.actions.reviewing"]()
                      : previewActionText(draft.mode)}
                  </Button>
                ) : (
                  <PreviewCard draft={draft} />
                )}
              </>
            )}
          </form>
        )}
      </section>
    </div>
  )
}

function conclusionTitle(mode: "existing" | "exclusion" | "new"): string {
  switch (mode) {
    case "existing":
      return m["assetCatalog.exceptions.decision.existingIdentity"]()
    case "new":
      return m["assetCatalog.exceptions.decision.newIdentity"]()
    case "exclusion":
      return m["assetCatalog.exceptions.decision.exclusion"]()
  }
}

function previewActionText(mode: "existing" | "exclusion" | "new" | null): string {
  switch (mode) {
    case "existing":
      return m["assetCatalog.exceptions.reviewUi.actions.reviewAttachment"]()
    case "new":
      return m["assetCatalog.exceptions.reviewUi.actions.reviewNewAsset"]()
    case "exclusion":
      return m["assetCatalog.exceptions.reviewUi.actions.reviewExclusion"]()
    case null:
      return m["assetCatalog.exceptions.reviewUi.actions.chooseResolution"]()
  }
}

function DataUpdateEvent({ detail }: { readonly detail: AssetExceptionDetail }) {
  const update = detail.rematerialization
  const meta =
    update.affectedSourceCount === 1
      ? m["assetCatalog.exceptions.reviewUi.dataUpdate.source"]({
          count: update.affectedSourceCount,
        })
      : m["assetCatalog.exceptions.reviewUi.dataUpdate.sources"]({
          count: update.affectedSourceCount,
        })
  switch (update.status) {
    case "pending":
      return (
        <TimelineEvent
          icon={<RefreshCw aria-hidden="true" />}
          meta={meta}
          title={m["assetCatalog.exceptions.reviewUi.dataUpdate.queuedTitle"]()}
        >
          <p className="text-sm text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.dataUpdate.queuedDescription"]()}
          </p>
        </TimelineEvent>
      )
    case "running":
      return (
        <TimelineEvent
          icon={<RefreshCw aria-hidden="true" />}
          meta={meta}
          title={m["assetCatalog.exceptions.reviewUi.dataUpdate.runningTitle"]()}
        >
          <p className="text-sm text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.dataUpdate.runningDescription"]()}
          </p>
        </TimelineEvent>
      )
    case "complete":
      return (
        <TimelineEvent
          icon={<CheckCircle2 aria-hidden="true" />}
          meta={meta}
          tone="success"
          title={m["assetCatalog.exceptions.reviewUi.dataUpdate.completeTitle"]()}
        >
          <p className="text-sm text-muted-foreground">
            {m["assetCatalog.exceptions.reviewUi.dataUpdate.completeDescription"]()}
          </p>
        </TimelineEvent>
      )
    case "operator_attention":
      return (
        <TimelineEvent
          icon={<AlertTriangle aria-hidden="true" />}
          meta={meta}
          tone="danger"
          title={m["assetCatalog.exceptions.reviewUi.dataUpdate.attentionTitle"]()}
        >
          <p className="text-sm text-destructive">
            {update.failedSourceCount === 1
              ? m["assetCatalog.exceptions.reviewUi.dataUpdate.attentionSource"]({
                  count: update.failedSourceCount,
                })
              : m["assetCatalog.exceptions.reviewUi.dataUpdate.attentionSources"]({
                  count: update.failedSourceCount,
                })}
          </p>
        </TimelineEvent>
      )
  }
}

function TimelineEvent({
  children,
  icon,
  meta,
  title,
  tone = "neutral",
}: {
  readonly children: ReactNode
  readonly icon: ReactNode
  readonly meta: string | null
  readonly title: string
  readonly tone?: "danger" | "neutral" | "success" | "warning"
}) {
  return (
    <article className="relative pb-7 last:pb-0">
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-[2.85rem] top-0 flex size-7 items-center justify-center rounded-full border bg-background [&>svg]:size-3.5",
          tone === "danger"
            ? "border-red-500/40 text-red-600"
            : tone === "warning"
              ? "border-amber-500/40 text-amber-600"
              : tone === "success"
                ? "border-emerald-500/40 text-emerald-600"
                : "border-border text-muted-foreground"
        )}
      >
        {icon}
      </span>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {meta === null ? null : <span className="text-xs text-muted-foreground">{meta}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </article>
  )
}
