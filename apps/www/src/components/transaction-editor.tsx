import { useEffect, useId, useRef } from "react"
import type { TransactionOverrideClassificationInput } from "taxmaxi"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import {
  type useTransactionEditor,
  type TransactionDraftGuard,
} from "#/components/use-transaction-editor"
import { m } from "#/paraglide/messages"

function categoryLabel(cause: TransactionOverrideClassificationInput["cause"]): string {
  const labels = {
    purchase: m["app.editor.category.purchase"],
    sale: m["app.editor.category.sale"],
    gift: m["app.editor.category.gift"],
    airdrop: m["app.editor.category.airdrop"],
    mining_reward: m["app.editor.category.mining"],
    staking_reward: m["app.editor.category.staking"],
    passive_staking_reward: m["app.editor.category.staking"],
    reward: m["app.editor.category.reward"],
    payment: m["app.editor.category.payment"],
    unknown: m["app.editor.category.unknown"],
  }
  return labels[cause]()
}

export function TransactionEditor({
  editor,
  guard,
}: {
  editor: ReturnType<typeof useTransactionEditor>
  guard: TransactionDraftGuard
}) {
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
  const category = editor.draft.kind === "classification"
  const title = category ? m["app.editor.categoryTitle"]() : m["app.editor.title"]()
  return (
    <form
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
          guard.rememberFocus(event.target)
      }}
      className="flex flex-col gap-4"
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="flex gap-2" aria-label={m["app.editor.kind"]()}>
        <Button
          type="button"
          variant={!category ? "secondary" : "outline"}
          aria-pressed={!category}
          disabled={editor.saving}
          onClick={() => editor.selectKind("price")}
          className="min-h-11"
        >
          {m["app.editor.priceTab"]()}
        </Button>
        <Button
          type="button"
          variant={category ? "secondary" : "outline"}
          aria-pressed={category}
          disabled={editor.saving}
          onClick={() => editor.selectKind("classification")}
          className="min-h-11"
        >
          {m["app.editor.categoryTab"]()}
        </Button>
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">
        {category ? m["app.editor.categoryScope"]() : m["app.editor.scope"]()}
      </p>
      <p className="text-sm break-all">
        {m["app.editor.quantity"]({
          quantity: editor.inspection.context.current?.facts.quantity ?? "—",
        })}
      </p>
      {!(category ? editor.categories.length > 0 : editor.eligible) && (
        <p role="status">{m["app.editor.unavailable"]()}</p>
      )}
      <fieldset disabled={editor.saving} className="flex flex-col gap-4">
        <legend className="sr-only">
          {category ? m["app.editor.categoryTab"]() : m["app.editor.mode"]()}
        </legend>
        {category ? (
          <>
            <fieldset className="grid grid-cols-2 gap-2">
              <legend className="mb-2">{m["app.editor.categoryTab"]()}</legend>
              {editor.categories.map((input) => (
                <label
                  key={input.cause}
                  className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm"
                >
                  <input
                    type="radio"
                    name={`${id}-category`}
                    checked={editor.draft.category === input.cause}
                    onChange={() => editor.change({ category: input.cause })}
                  />
                  {categoryLabel(input.cause)}
                </label>
              ))}
            </fieldset>
            {editor.clarifyStaking && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2">{m["app.editor.passiveQuestion"]()}</legend>
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-passive`}
                    checked={editor.draft.passive}
                    onChange={() => editor.change({ passive: true })}
                  />
                  {m["app.editor.passiveYes"]()}
                </label>
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-passive`}
                    checked={!editor.draft.passive}
                    onChange={() => editor.change({ passive: false })}
                  />
                  {m["app.editor.passiveUnknown"]()}
                </label>
              </fieldset>
            )}
          </>
        ) : (
          <>
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={!editor.eligible}
                variant={editor.draft.mode === "unit_price" ? "secondary" : "outline"}
                aria-pressed={editor.draft.mode === "unit_price"}
                onClick={() => editor.change({ mode: "unit_price" })}
                className="min-h-11"
              >
                {m["app.editor.unit"]()}
              </Button>
              <Button
                type="button"
                disabled={!editor.eligible}
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
                disabled={!editor.eligible}
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
          </>
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
        <Button type="submit" disabled={!editor.eligible} className="min-h-11">
          {editor.saving ? m["app.editor.saving"]() : m["app.editor.save"]()}
        </Button>
        {editor.inspection.context[editor.draft.kind].active && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!editor.canWithdraw}
            onClick={() => void save(true)}
          >
            {category ? m["app.editor.categoryWithdraw"]() : m["app.editor.withdraw"]()}
          </Button>
        )}
      </fieldset>
    </form>
  )
}
