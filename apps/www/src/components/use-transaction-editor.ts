import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useQueryClient } from "@tanstack/react-query"
import * as BigDecimal from "effect/BigDecimal"
import * as Option from "effect/Option"
import { z } from "zod"
import {
  isTaxMaxiUnauthorizedError,
  type Account,
  type TaxMaxi,
  type TransactionOverrideCurrent,
  type TransactionOverridePriceInput,
} from "taxmaxi"
import { queryKeys, refreshTransactionQueries } from "#/integrations/taxmaxi/queries"
import { m } from "#/paraglide/messages"

export function useTransactionDraftGuard() {
  const state = useRef({ dirty: false, saving: false })
  const [pending, setPending] = useState(false)
  const decision = useRef<((discard: boolean) => void) | null>(null)
  const discardDraft = useRef<(() => void) | null>(null)
  const registerDiscard = useCallback((reset: () => void) => {
    discardDraft.current = reset
    return () => {
      if (discardDraft.current === reset) discardDraft.current = null
    }
  }, [])
  const returnFocus = useRef<HTMLElement | null>(null)
  const restoreAfterDecision = useRef(false)
  const rememberFocus = useCallback((element: HTMLElement | null) => {
    returnFocus.current = element
  }, [])
  useEffect(() => {
    if (!pending && restoreAfterDecision.current) {
      restoreAfterDecision.current = false
      returnFocus.current?.focus({ preventScroll: true })
    }
  }, [pending])
  const update = useCallback((next: { dirty: boolean; saving: boolean }) => {
    state.current = next
  }, [])
  const resolve = useCallback((discard: boolean) => {
    if (!decision.current) return
    if (discard) {
      discardDraft.current?.()
      state.current = { dirty: false, saving: false }
    }
    decision.current?.(discard)
    decision.current = null
    setPending(false)
    restoreAfterDecision.current = !discard
  }, [])
  const request = useCallback(async () => {
    if (state.current.saving || decision.current) return false
    if (!state.current.dirty) return true
    if (!returnFocus.current?.isConnected)
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPending(true)
    return new Promise<boolean>((accept) => {
      decision.current = accept
    })
  }, [])
  const run = useCallback(
    (action: () => void) => {
      if (!state.current.dirty && !state.current.saving && !decision.current) {
        action()
        return
      }
      void request().then((allowed) => {
        if (allowed) action()
      })
    },
    [request]
  )
  useEffect(
    () => () => {
      decision.current?.(false)
    },
    []
  )
  return {
    pending,
    request,
    run,
    resolve,
    update,
    rememberFocus,
    registerDiscard,
    isDirty: () => state.current.dirty,
  }
}

export type TransactionDraftGuard = ReturnType<typeof useTransactionDraftGuard>
type Draft = { mode: TransactionOverridePriceInput["_tag"]; amount: string; reason: string }
const amountSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/)

/** Exact total preview only; a total-value draft is never rebuilt from a unit preview. */
export function transactionPriceTotal({
  amount,
  quantity,
  mode,
}: {
  amount: string
  quantity: string
  mode: Draft["mode"]
}): string | null {
  const parsed = amountSchema.safeParse(amount)
  const units = BigDecimal.fromString(quantity)
  if (!parsed.success || Option.isNone(units) || !BigDecimal.isPositive(units.value)) return null
  if (mode === "total_value") return parsed.data
  const total = BigDecimal.multiply(BigDecimal.fromStringUnsafe(parsed.data), units.value)
  const digits = total.value.toString()
  if (total.scale <= 0) return digits + "0".repeat(-total.scale)
  const padded = digits.padStart(total.scale + 1, "0")
  return `${padded.slice(0, -total.scale)}.${padded.slice(-total.scale)}`
}

export function useTransactionEditor({
  taxmaxi,
  targetId,
  taxYear,
  guard,
  onSaved,
  onUnauthorized,
}: {
  taxmaxi: TaxMaxi
  targetId: string | null
  taxYear: number | undefined
  guard: TransactionDraftGuard
  onSaved: () => void
  onUnauthorized: () => void | Promise<void>
}) {
  const queryClient = useQueryClient()
  const currentUser = () => queryClient.getQueryData<Account>(queryKeys.account())?.account.id
  const userId = useSyncExternalStore(
    useCallback(
      (notify: () => void) => queryClient.getQueryCache().subscribe(notify),
      [queryClient]
    ),
    currentUser,
    currentUser
  )
  const readScope = JSON.stringify([targetId, taxYear, userId])
  const [loadedScope, setLoadedScope] = useState<string | null>(null)
  const [loadedInspection, setInspection] = useState<TransactionOverrideCurrent | null>(null)
  const inspection = loadedScope === readScope ? loadedInspection : null
  const [draft, setDraft] = useState<Draft>({
    mode: "total_value",
    amount: "",
    reason: m["app.editor.defaultReason"](),
  })
  const initial = useRef(draft)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const [retry, setRetry] = useState(0)
  useEffect(
    () =>
      guard.registerDiscard(() => {
        setDraft(initial.current)
        setError(null)
      }),
    [guard.registerDiscard]
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      guard.update({ dirty: false, saving: false })
    }
  }, [guard.update])
  useEffect(() => {
    const controller = new AbortController()
    guard.resolve(false)
    generation.current += 1
    busy.current = false
    setSaving(false)
    setInspection(null)
    setLoadedScope(null)
    setLoading(true)
    setError(null)
    guard.update({ dirty: false, saving: false })
    if (!userId || !targetId || taxYear === undefined) {
      setLoading(false)
      return () => controller.abort()
    }
    void taxmaxi.transactionOverrides
      .getCurrent({ targetId, taxYear }, { signal: controller.signal })
      .then((current) => {
        if (controller.signal.aborted || currentUser() !== userId) return
        const active = current.context.price.active
        const price = active?.input?._tag === "price" ? active.input.input : null
        const next: Draft = {
          mode: price?._tag ?? "total_value",
          amount: price?.amount ?? "",
          reason: active?.reason ?? m["app.editor.defaultReason"](),
        }
        initial.current = next
        setDraft(next)
        setInspection(current)
        setLoadedScope(readScope)
        setLoading(false)
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || currentUser() !== userId) return
        setLoading(false)
        setError(m["app.editor.loadError"]())
        if (isTaxMaxiUnauthorizedError(failure)) void onUnauthorized()
      })
    return () => controller.abort()
  }, [taxmaxi, targetId, taxYear, userId, retry, guard.update, guard.resolve])
  const change = (next: Partial<Draft>) => {
    if (busy.current) return
    const changed = { ...draft, ...next }
    setDraft(changed)
    setError(null)
    guard.update({
      dirty:
        changed.mode !== initial.current.mode ||
        changed.amount !== initial.current.amount ||
        changed.reason !== initial.current.reason,
      saving: false,
    })
  }
  const submit = async (withdraw = false): Promise<boolean> => {
    const current = inspection?.context.current
    if (
      busy.current ||
      !inspection ||
      !current ||
      !targetId ||
      !userId ||
      currentUser() !== userId ||
      (!withdraw &&
        (current.facts.structure === "custody" || inspection.scope.reportingCurrency !== "EUR")) ||
      (withdraw && !inspection.context.price.active)
    )
      return false
    const parsed = amountSchema.safeParse(draft.amount)
    if (!draft.reason.trim() || (!withdraw && !parsed.success)) {
      setError(m["app.editor.validation"]())
      return false
    }
    const startedGeneration = generation.current
    busy.current = true
    setSaving(true)
    setError(null)
    guard.update({ dirty: true, saving: true })
    const compare = {
      expectedLeafId: inspection.context.price.leaf?.id ?? null,
      expectedSystemRevision: current.facts.systemRevision,
      reason: draft.reason.trim(),
    }
    try {
      if (withdraw) {
        await taxmaxi.transactionOverrides.withdraw({
          targetId,
          withdrawal: { ...compare, kind: "price" },
        })
      } else if (parsed.success) {
        const input = {
          ...compare,
          input: {
            _tag: "price" as const,
            input: { _tag: draft.mode, amount: parsed.data, currency: "EUR" as const },
          },
        }
        if (inspection.context.price.active)
          await taxmaxi.transactionOverrides.replace({ targetId, replacement: input })
        else await taxmaxi.transactionOverrides.create({ targetId, override: input })
      }
      if (!mounted.current || currentUser() !== userId || generation.current !== startedGeneration)
        return false
      guard.update({ dirty: false, saving: false })
      onSaved()
      // Acceptance is already committed. Refresh failure cannot turn it into a failed save.
      void refreshTransactionQueries(queryClient).catch(() => undefined)
      return true
    } catch (failure) {
      if (!mounted.current || currentUser() !== userId || generation.current !== startedGeneration)
        return false
      setError(m["app.editor.saveError"]())
      guard.update({ dirty: true, saving: false })
      if (isTaxMaxiUnauthorizedError(failure)) void onUnauthorized()
      return false
    } finally {
      if (mounted.current && currentUser() === userId && generation.current === startedGeneration) {
        busy.current = false
        setSaving(false)
      }
    }
  }
  const facts = inspection?.context.current?.facts
  const eligible =
    !!userId &&
    !!facts &&
    facts.structure !== "custody" &&
    inspection?.scope.reportingCurrency === "EUR"
  return {
    draft,
    change,
    submit,
    inspection,
    loading,
    error,
    saving,
    eligible,
    canWithdraw: !!userId && !!facts && !!inspection?.context.price.active,
    retry: () => setRetry((value) => value + 1),
    total: facts
      ? transactionPriceTotal({ amount: draft.amount, quantity: facts.quantity, mode: draft.mode })
      : null,
  }
}
