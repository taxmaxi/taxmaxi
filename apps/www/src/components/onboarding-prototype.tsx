import { useEffect } from "react"
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, ArrowRight, Check, CircleDashed, Loader2, X } from "lucide-react"

import { appSurfaceClassName, appPanelClassName } from "#/components/app-workspace"
import { SourceCards } from "#/components/source-cards"
import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"
import type { Source } from "#/components/source-card"

/*
 * PROTOTYPE — THROWAWAY CODE. Do not ship, do not polish, do not reuse.
 *
 * Three variants of the onboarding experience for issue #108, mounted on the
 * existing /app route and switched via the ?variant= search param, with a
 * ?step= param to preview every onboarding state. Dev builds only.
 *
 *   a — Full-screen letter wizard: onboarding takes over the whole page.
 *   b — Stepped empty state: dashboard chrome stays, the content sheet
 *       becomes a setup checklist.
 *   c — Guided panel: dashboard shows dimmed behind a docked letter panel.
 *
 * Copy is hardcoded English on purpose: it is placeholder founder copy to be
 * judged and rewritten, and paraglide keys for throwaway screens are waste.
 * The real implementation localizes everything.
 */

export const ONBOARDING_PROTOTYPE_ENABLED = import.meta.env.DEV && import.meta.env.MODE !== "test"

export const ONBOARDING_PROTOTYPE_VARIANTS = ["a", "b", "c"] as const
export type OnboardingPrototypeVariant = (typeof ONBOARDING_PROTOTYPE_VARIANTS)[number]

export const ONBOARDING_PROTOTYPE_STEPS = [
  "welcome",
  "no-plan",
  "ready",
  "syncing",
  "paused",
  "done",
] as const
export type OnboardingPrototypeStep = (typeof ONBOARDING_PROTOTYPE_STEPS)[number]

const VARIANT_NAMES: Record<OnboardingPrototypeVariant, string> = {
  a: "Full-screen letter",
  b: "Stepped empty state",
  c: "Guided panel",
}

const STEP_LABELS: Record<OnboardingPrototypeStep, string> = {
  welcome: "Welcome",
  "no-plan": "No plan",
  ready: "Ready",
  syncing: "Syncing",
  paused: "Paused",
  done: "Done",
}

const MOCK = {
  credits: 500,
  syncProgress: 38,
  fetchedRecords: 1204,
  creditsConsumed: 320,
  additionalCreditsRequired: 180,
  importedTransactions: 1524,
}

const MOCK_COINBASE: Source = {
  id: "prototype-coinbase",
  name: "Coinbase",
  kind: "exchange",
  importedTransactions: 0,
  unresolvedItems: 0,
  lastSync: "Never synced",
}

type StepProps = {
  step: OnboardingPrototypeStep
  onGoToStep: (step: OnboardingPrototypeStep) => void
  onExit: () => void
}

export function OnboardingPrototype({
  step,
  variant,
}: {
  step: OnboardingPrototypeStep | undefined
  variant: OnboardingPrototypeVariant
}) {
  const navigate = useNavigate({ from: "/app" })
  const currentStep = step ?? "welcome"

  const setParams = (updates: {
    step?: OnboardingPrototypeStep
    variant?: OnboardingPrototypeVariant
  }) => {
    void navigate({
      replace: true,
      to: ".",
      search: (previous) => ({ ...previous, ...updates }),
    })
  }

  const onGoToStep = (nextStep: OnboardingPrototypeStep) => setParams({ step: nextStep })

  const onExit = () => {
    void navigate({
      replace: true,
      to: ".",
      search: (previous) => ({ ...previous, step: undefined, variant: undefined }),
    })
  }

  const stepProps: StepProps = { step: currentStep, onGoToStep, onExit }

  return (
    <>
      {variant === "a" ? <VariantFullScreenLetter {...stepProps} /> : null}
      {variant === "b" ? <VariantSteppedEmptyState {...stepProps} /> : null}
      {variant === "c" ? <VariantGuidedPanel {...stepProps} /> : null}
      <PrototypeSwitcher
        onExit={onExit}
        onSelectStep={onGoToStep}
        onSelectVariant={(nextVariant) => setParams({ variant: nextVariant })}
        step={currentStep}
        variant={variant}
      />
    </>
  )
}

/* ─────────────────────────────────────────────────────────
 * Shared copy atoms. Only copy and tiny value blocks are shared;
 * every variant owns its own layout.
 * ───────────────────────────────────────────────────────── */

function FounderLetterBody({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("space-y-3 leading-relaxed", compact ? "text-sm" : "text-base")}>
      <p>
        Thanks for trying TaxMaxi. I&rsquo;m building it to be the last crypto tax tool you&rsquo;ll
        ever need.
      </p>
      <p>
        That&rsquo;s a big promise, so here is what it stands on: we put you first, we are open
        &mdash; literally, the code is public &mdash; and everything is modular, so TaxMaxi grows
        with whatever you do on-chain.
      </p>
      <p>
        Your Coinbase account is connected and TaxMaxi has created a source for it. Nothing has been
        imported yet &mdash; you decide when that happens.
      </p>
    </div>
  )
}

function FounderSignature() {
  return (
    <p className="font-serif text-xl italic" style={{ fontFamily: "cursive" }}>
      &mdash; Max
    </p>
  )
}

function CreditBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-foreground/8 px-2.5 py-0.5 text-xs font-medium tabular-nums">
      {children}
    </span>
  )
}

function SyncProgressBar({ paused }: { paused?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="h-2 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className={cn("h-full rounded-full", paused ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${MOCK.syncProgress}%` }}
        />
      </div>
      <p className="text-xs tabular-nums text-muted-foreground">
        {paused
          ? `Paused — ${MOCK.creditsConsumed.toLocaleString()} transactions covered so far`
          : `${MOCK.fetchedRecords.toLocaleString()} records fetched from Coinbase`}
      </p>
    </div>
  )
}

/**
 * The state-dependent action block every variant needs: what the user sees
 * for plan/credits, sync progress, pause, and completion. Shared as content
 * only — each variant places and frames it differently.
 */
function StepActionBlock({ step, onGoToStep, onExit }: StepProps) {
  switch (step) {
    case "welcome":
      return (
        <Button onClick={() => onGoToStep("no-plan")} size="sm" type="button">
          Set up my first import
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Button>
      )
    case "no-plan":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Importing your history uses transaction credits &mdash; one credit per transaction. You
            don&rsquo;t have a plan yet, so there are no credits to spend.
          </p>
          <Button onClick={() => onGoToStep("ready")} size="sm" type="button">
            Choose a plan
          </Button>
        </div>
      )
    case "ready":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You have <CreditBadge>{MOCK.credits} credits</CreditBadge> &mdash; enough to import your
            Coinbase history. Nothing starts until you say so.
          </p>
          <Button onClick={() => onGoToStep("syncing")} size="sm" type="button">
            Start my first sync
          </Button>
        </div>
      )
    case "syncing":
      return (
        <div className="space-y-3">
          <SyncProgressBar />
          <button
            className="text-xs text-muted-foreground underline underline-offset-2"
            onClick={() => onGoToStep("done")}
            type="button"
          >
            (prototype: simulate finish)
          </button>
        </div>
      )
    case "paused":
      return (
        <div className="space-y-3">
          <SyncProgressBar paused />
          <p className="text-sm text-muted-foreground">
            Your credits ran out mid-import. {MOCK.additionalCreditsRequired} more credits cover the
            rest &mdash; everything fetched so far is kept, and the sync continues where it stopped.
          </p>
          <Button onClick={() => onGoToStep("syncing")} size="sm" type="button">
            Buy {MOCK.additionalCreditsRequired} credits
          </Button>
        </div>
      )
    case "done":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            First sync complete: {MOCK.importedTransactions.toLocaleString()} transactions imported.
            Your dashboard is ready.
          </p>
          <Button onClick={onExit} size="sm" type="button">
            Go to my dashboard
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      )
  }
}

/* ─────────────────────────────────────────────────────────
 * Variant A — full-screen letter wizard.
 * Onboarding takes over the page; the dashboard does not exist
 * until setup is done. Personal, focused, zero distraction.
 * ───────────────────────────────────────────────────────── */

const WIZARD_STAGES = ["Welcome", "Plan", "First sync", "Done"] as const

function wizardStageIndex(step: OnboardingPrototypeStep): number {
  switch (step) {
    case "welcome":
      return 0
    case "no-plan":
    case "ready":
      return 1
    case "syncing":
    case "paused":
      return 2
    case "done":
      return 3
  }
}

function VariantFullScreenLetter(props: StepProps) {
  const { step } = props
  const stageIndex = wizardStageIndex(step)

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 pt-28 pb-20 sm:pt-32">
      <div className={cn(appPanelClassName, "w-full max-w-xl p-8 sm:p-10")}>
        {step === "welcome" ? (
          <div className="space-y-5">
            <p className="text-3xl font-semibold tracking-tight">Hi, I&rsquo;m Max.</p>
            <FounderLetterBody />
            <FounderSignature />
            <div className="pt-2">
              <StepActionBlock {...props} />
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <Check aria-hidden="true" className="size-4" strokeWidth={3} />
              Coinbase connected
            </div>
            <p className="text-2xl font-semibold tracking-tight">{wizardHeadline(step)}</p>
            <StepActionBlock {...props} />
          </div>
        )}
      </div>

      <div aria-hidden="true" className="mt-6 flex items-center gap-2">
        {WIZARD_STAGES.map((stage, index) => (
          <span
            className={cn(
              "size-1.5 rounded-full",
              index === stageIndex ? "bg-foreground" : "bg-foreground/25"
            )}
            key={stage}
            title={stage}
          />
        ))}
      </div>
    </div>
  )
}

function wizardHeadline(step: OnboardingPrototypeStep): string {
  switch (step) {
    case "welcome":
      return ""
    case "no-plan":
      return "Pick a plan to unlock your import"
    case "ready":
      return "Ready when you are"
    case "syncing":
      return "Importing your Coinbase history"
    case "paused":
      return "Sync paused — more credits needed"
    case "done":
      return "You're all set"
  }
}

/* ─────────────────────────────────────────────────────────
 * Variant B — stepped empty state.
 * The real dashboard chrome stays: the Coinbase source card sits in the
 * fan, and the content sheet (where tabs normally live) becomes a setup
 * checklist with a compact founder note on top.
 * ───────────────────────────────────────────────────────── */

type ChecklistState = "done" | "active" | "upcoming"

function checklistStates(
  step: OnboardingPrototypeStep
): [ChecklistState, ChecklistState, ChecklistState] {
  switch (step) {
    case "welcome":
    case "no-plan":
      return ["done", "active", "upcoming"]
    case "ready":
    case "syncing":
    case "paused":
      return ["done", "done", "active"]
    case "done":
      return ["done", "done", "done"]
  }
}

function ChecklistIcon({ state }: { state: ChecklistState }) {
  if (state === "done") {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-emerald-500/15 text-emerald-600">
        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
      </span>
    )
  }
  if (state === "active") {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-foreground text-background">
        <Loader2 aria-hidden="true" className="size-3.5" />
      </span>
    )
  }
  return (
    <span className="grid size-6 place-items-center rounded-full text-muted-foreground">
      <CircleDashed aria-hidden="true" className="size-4" />
    </span>
  )
}

function VariantSteppedEmptyState(props: StepProps) {
  const { step } = props
  const [connectState, planState, syncState] = checklistStates(step)

  return (
    <div className="text-marketing-foreground flex min-h-screen flex-col pt-28 pb-8 sm:pt-32">
      <SourceCards contentClassName={appSurfaceClassName} sources={[MOCK_COINBASE]}>
        <div className="flex min-w-0 flex-col gap-8 py-6 sm:py-8">
          <div className="flex flex-col gap-1">
            <p className="text-3xl font-semibold tabular-nums text-muted-foreground/60 sm:text-5xl">
              &mdash;
            </p>
            <p className="text-sm text-muted-foreground">
              {step === "done"
                ? "First sync complete — your portfolio appears here."
                : "No data yet. Finish the setup below to fill this in."}
            </p>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/40 p-4">
            <p className="text-sm font-medium">A note from Max</p>
            <div className="mt-2 text-muted-foreground">
              <FounderLetterBody compact />
            </div>
            <div className="mt-3">
              <FounderSignature />
            </div>
          </div>

          <ol className="flex flex-col gap-6">
            <li className="flex gap-3">
              <ChecklistIcon state={connectState} />
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm font-medium">Connect Coinbase</p>
                <p className="text-xs text-muted-foreground">
                  Done — TaxMaxi created your Coinbase source.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <ChecklistIcon state={planState} />
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm font-medium">Get transaction credits</p>
                {planState === "active" ? (
                  <div className="mt-2 max-w-md">
                    <StepActionBlock {...props} step="no-plan" />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {planState === "done"
                      ? `Covered — ${MOCK.credits} credits available.`
                      : "Credits pay for importing transactions."}
                  </p>
                )}
              </div>
            </li>
            <li className="flex gap-3">
              <ChecklistIcon state={syncState} />
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm font-medium">Import your history</p>
                {syncState === "active" || syncState === "done" ? (
                  <div className="mt-2 max-w-md">
                    <StepActionBlock
                      {...props}
                      step={step === "welcome" || step === "no-plan" ? "ready" : step}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    One explicit click starts your first sync.
                  </p>
                )}
              </div>
            </li>
          </ol>
        </div>
      </SourceCards>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * Variant C — guided panel.
 * The dashboard renders as a dimmed, non-interactive preview so the user
 * can see what they are working toward; a docked letter panel carries the
 * welcome and the setup actions. On completion the dashboard sharpens.
 * ───────────────────────────────────────────────────────── */

function VariantGuidedPanel(props: StepProps) {
  const { step } = props
  const settled = step === "done"

  return (
    <div className="text-marketing-foreground flex min-h-screen flex-col pt-28 pb-8 sm:pt-32">
      <div
        aria-hidden={!settled}
        className={cn(
          "transition-[filter,opacity] duration-500",
          settled ? undefined : "pointer-events-none select-none opacity-50 blur-[2px]"
        )}
      >
        <SourceCards contentClassName={appSurfaceClassName} sources={[MOCK_COINBASE]}>
          <div className="flex min-w-0 flex-col gap-8 py-6 sm:py-8">
            <p className="text-3xl font-semibold tabular-nums text-muted-foreground/50 sm:text-5xl">
              &euro;&thinsp;&mdash;
            </p>
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((row) => (
                <div
                  className="h-10 animate-pulse rounded-lg bg-foreground/6"
                  key={row}
                  style={{ animationDelay: `${row * 120}ms` }}
                />
              ))}
            </div>
          </div>
        </SourceCards>
      </div>

      {settled ? null : (
        <aside
          aria-label="Setup"
          className={cn(
            appPanelClassName,
            "fixed right-4 top-24 bottom-8 z-40 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-5 overflow-y-auto p-6"
          )}
        >
          <div>
            <p className="text-xl font-semibold tracking-tight">Hi, I&rsquo;m Max.</p>
            <div className="mt-3 text-muted-foreground">
              <FounderLetterBody compact />
            </div>
            <div className="mt-3">
              <FounderSignature />
            </div>
          </div>

          <div className="border-t border-border/60 pt-4">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {STEP_LABELS[step]}
            </p>
            <div className="mt-3">
              <StepActionBlock {...props} />
            </div>
          </div>
        </aside>
      )}

      {settled ? (
        <div className="fixed bottom-20 left-1/2 z-40 -translate-x-1/2">
          <div className={cn(appPanelClassName, "px-5 py-3")}>
            <StepActionBlock {...props} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * Floating switcher — obviously not part of the design.
 * ───────────────────────────────────────────────────────── */

function PrototypeSwitcher({
  onExit,
  onSelectStep,
  onSelectVariant,
  step,
  variant,
}: {
  onExit: () => void
  onSelectStep: (step: OnboardingPrototypeStep) => void
  onSelectVariant: (variant: OnboardingPrototypeVariant) => void
  step: OnboardingPrototypeStep
  variant: OnboardingPrototypeVariant
}) {
  const cycle = (direction: 1 | -1) => {
    const index = ONBOARDING_PROTOTYPE_VARIANTS.indexOf(variant)
    const count = ONBOARDING_PROTOTYPE_VARIANTS.length
    const next = ONBOARDING_PROTOTYPE_VARIANTS[(index + direction + count) % count]
    if (next !== undefined) {
      onSelectVariant(next)
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return
      }
      cycle(event.key === "ArrowRight" ? 1 : -1)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  })

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5 rounded-2xl bg-zinc-900 px-3 py-2 text-white shadow-xl ring-1 ring-white/10">
      <div className="flex items-center gap-2">
        <button
          aria-label="Previous variant"
          className="grid size-7 place-items-center rounded-full hover:bg-white/10"
          onClick={() => cycle(-1)}
          type="button"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </button>
        <span className="min-w-44 text-center text-xs font-medium">
          {variant.toUpperCase()} &mdash; {VARIANT_NAMES[variant]}
        </span>
        <button
          aria-label="Next variant"
          className="grid size-7 place-items-center rounded-full hover:bg-white/10"
          onClick={() => cycle(1)}
          type="button"
        >
          <ArrowRight aria-hidden="true" className="size-4" />
        </button>
        <button
          aria-label="Exit prototype"
          className="grid size-7 place-items-center rounded-full text-white/60 hover:bg-white/10"
          onClick={onExit}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="flex items-center gap-1">
        {ONBOARDING_PROTOTYPE_STEPS.map((candidate) => (
          <button
            className={cn(
              "rounded-full px-2 py-0.5 text-[0.625rem] font-medium",
              candidate === step ? "bg-white text-zinc-900" : "text-white/60 hover:bg-white/10"
            )}
            key={candidate}
            onClick={() => onSelectStep(candidate)}
            type="button"
          >
            {STEP_LABELS[candidate]}
          </button>
        ))}
      </div>
    </div>
  )
}
