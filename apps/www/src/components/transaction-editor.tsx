import { useEffect, useId, useRef } from "react"
import type { TaxMaxi } from "taxmaxi"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import {
  useTransactionEditor,
  type TransactionDraftGuard,
} from "#/components/use-transaction-editor"
import { m } from "#/paraglide/messages"

export function TransactionEditor(props: {
  taxmaxi: TaxMaxi
  targetId: string
  taxYear: number
  guard: TransactionDraftGuard
  onSaved: () => void
  onUnauthorized: () => void | Promise<void>
}) {
  const editor = useTransactionEditor(props)
  const id = useId()
  const amountRef = useRef<HTMLInputElement>(null)
  const failedFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!editor.saving && editor.error)
      (failedFocus.current ?? amountRef.current)?.focus({ preventScroll: true })
  }, [editor.saving, editor.error])
  const save = (withdraw = false) => {
    failedFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : amountRef.current
    void editor.submit(withdraw)
  }
  if (editor.loading) return <p role="status">{m["app.editor.loading"]()}</p>
  if (!editor.inspection)
    return (
      <div className="flex flex-col gap-3">
        <p role="alert">{editor.error ?? m["app.editor.unavailable"]()}</p>
        <Button onClick={editor.retry}>{m["app.treatment.retry"]()}</Button>
      </div>
    )
  return (
    <form
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
          props.guard.rememberFocus(event.target)
      }}
      className="flex flex-col gap-4"
      aria-label={m["app.editor.title"]()}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <h3 className="font-semibold">{m["app.editor.title"]()}</h3>
      <p className="text-sm text-muted-foreground">{m["app.editor.scope"]()}</p>
      <p className="text-sm break-all">
        {m["app.editor.quantity"]({
          quantity: editor.inspection.context.current?.facts.quantity ?? "—",
        })}
      </p>
      {!editor.eligible && <p role="status">{m["app.editor.unavailable"]()}</p>}
      <fieldset disabled={editor.saving || !editor.eligible} className="flex flex-col gap-4">
        <legend className="sr-only">{m["app.editor.mode"]()}</legend>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={editor.draft.mode === "unit_price" ? "secondary" : "outline"}
            aria-pressed={editor.draft.mode === "unit_price"}
            onClick={() => editor.change({ mode: "unit_price" })}
            className="min-h-11"
          >
            {m["app.editor.unit"]()}
          </Button>
          <Button
            type="button"
            variant={editor.draft.mode === "total_value" ? "secondary" : "outline"}
            aria-pressed={editor.draft.mode === "total_value"}
            onClick={() => editor.change({ mode: "total_value" })}
            className="min-h-11"
          >
            {m["app.editor.total"]()}
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-amount`}>
            {editor.draft.mode === "unit_price"
              ? m["app.editor.unitEur"]()
              : m["app.editor.totalEur"]()}
          </label>
          <Input
            ref={amountRef}
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            className="min-h-11 text-base tabular-nums"
            value={editor.draft.amount}
            onChange={(event) => editor.change({ amount: event.target.value })}
            aria-invalid={editor.error !== null}
            aria-describedby={editor.error ? `${id}-error` : undefined}
          />
        </div>
        {editor.total !== null && (
          <p className="text-sm break-all tabular-nums" aria-live="polite">
            {m["app.editor.exactTotal"]({ amount: editor.total })}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-reason`}>{m["app.editor.reason"]()}</label>
          <textarea
            id={`${id}-reason`}
            className="min-h-24 w-full rounded-md border bg-transparent p-3 text-base"
            value={editor.draft.reason}
            onChange={(event) => editor.change({ reason: event.target.value })}
          />
        </div>
        {editor.error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {editor.error}
          </p>
        )}
        <Button type="submit" className="min-h-11">
          {editor.saving ? m["app.editor.saving"]() : m["app.editor.save"]()}
        </Button>
        {editor.inspection.context.price.active && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void save(true)}
          >
            {m["app.editor.withdraw"]()}
          </Button>
        )}
      </fieldset>
    </form>
  )
}
