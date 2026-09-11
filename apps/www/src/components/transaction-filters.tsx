import { useId, useRef, useState, type MouseEvent, type Ref } from "react"
import type { TransactionFilterChoices } from "taxmaxi"
import { X, Plus } from "lucide-react"
import { Button } from "#/components/ui/button"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "#/components/ui/command"
import { Popover, PopoverTrigger, PopoverContent } from "#/components/ui/popover"
import type { Account } from "#/lib/dashboard-types"
import {
  parseTransactionFilters,
  transactionFilterYear,
  transactionYearFilters,
  type TransactionFilters,
} from "#/lib/transaction-filters"
import { Input } from "#/components/ui/input"
import { Checkbox } from "#/components/ui/checkbox"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "#/components/ui/select"
import { m } from "#/paraglide/messages"

type Category = NonNullable<TransactionFilters["categories"]>[number]
type Choice = { id: string; label: string; detail?: string }

const categoryLabels = () =>
  ({
    purchase: m["app.transactionFilters.purchase"](),
    sale: m["app.transactionFilters.sale"](),
    gift: m["app.transactionFilters.gift"](),
    airdrop: m["app.transactionFilters.airdrop"](),
    mining_reward: m["app.transactionFilters.mining"](),
    staking: m["app.transactionFilters.staking"](),
    staking_reward: m["app.transactionFilters.unspecifiedStaking"](),
    passive_staking_reward: m["app.transactionFilters.passiveStaking"](),
    reward: m["app.transactionFilters.reward"](),
    payment: m["app.transactionFilters.payment"](),
    unknown: m["app.transactionFilters.unknown"](),
    custody_movement: m["app.transactionFilters.transfer"](),
  }) satisfies Record<Category, string>

function FilterMenu({
  label,
  choices,
  selected,
  onToggle,
  disabled,
  loading,
  failed,
  onRetry,
  triggerRef,
}: {
  triggerRef: Ref<HTMLButtonElement>
  label: string
  choices: ReadonlyArray<Choice>
  selected: ReadonlyArray<string>
  onToggle: (id: string) => void
  disabled: boolean
  loading?: boolean
  failed?: boolean
  onRetry?: () => void
}) {
  const selectedIds = new Set(selected)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          aria-label={m["app.transactionFilters.edit"]({ group: label })}
        >
          <Plus data-icon="inline-start" />
          {label}
          {selected.length > 0 ? <span className="tabular-nums">{selected.length}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        collisionPadding={8}
        className="max-h-(--radix-popover-content-available-height) w-88 max-w-[calc(100vw-2rem)] overflow-y-auto p-1 motion-reduce:[--tw-enter-scale:1]! motion-reduce:[--tw-exit-scale:1]! motion-reduce:[--tw-enter-translate-x:0]! motion-reduce:[--tw-enter-translate-y:0]! motion-reduce:[--tw-exit-translate-x:0]! motion-reduce:[--tw-exit-translate-y:0]!"
      >
        <Command
          label={label}
          className="h-auto shrink-0 overflow-visible [&_[data-slot=input-group]]:min-h-11"
        >
          <CommandInput
            aria-label={m["app.transactionFilters.search"]({ group: label })}
            placeholder={m["app.transactionFilters.search"]({ group: label })}
            className="min-h-11 text-base"
          />
          {loading ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              {m["app.transactionFilters.loading"]()}
            </p>
          ) : null}
          <CommandList aria-label={label} className="max-h-none overflow-visible">
            {!loading ? (
              <CommandEmpty>{m["app.transactionFilters.noChoices"]()}</CommandEmpty>
            ) : null}
            <CommandGroup>
              {choices.map((choice) => (
                <CommandItem
                  key={choice.id}
                  value={choice.id}
                  keywords={[choice.label, choice.detail ?? ""]}
                  data-checked={selectedIds.has(choice.id)}
                  onSelect={() => onToggle(choice.id)}
                  className="min-h-11"
                >
                  <span className="min-w-0 break-words">
                    <span>{choice.label}</span>
                    {choice.detail ? (
                      <span className="block break-all text-xs text-muted-foreground">
                        {choice.detail}
                      </span>
                    ) : null}
                    <span className="sr-only">
                      {selectedIds.has(choice.id)
                        ? m["app.transactionFilters.selected"]()
                        : m["app.transactionFilters.notSelected"]()}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {failed ? (
          <div role="status" className="flex flex-col gap-2 p-3">
            <p>{m["app.transactionFilters.failed"]()}</p>
            <Button variant="outline" className="min-h-11" onClick={onRetry}>
              {m["app.transactionFilters.retry"]()}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function DateFilterForm({
  filters,
  onApply,
  disabled,
}: {
  filters: TransactionFilters
  onApply: (filters: TransactionFilters) => void
  disabled: boolean
}) {
  const id = useId()
  const [year, setYear] = useState(filters.from?.slice(0, 4) ?? "")
  const [from, setFrom] = useState(filters.from ?? "")
  const [to, setTo] = useState(filters.to ?? "")
  const [textDates] = useState(() =>
    [filters.from, filters.to].some((date) => date?.startsWith("0000-"))
  )
  const [error, setError] = useState<{ form: "year" | "range"; message: string }>()
  const timezone = filters.timezone ?? "Europe/Berlin"
  const apply = (form: "year" | "range", read: () => TransactionFilters) => {
    try {
      const next = read()
      setError(undefined)
      onApply(next)
    } catch (cause) {
      setError({
        form,
        message:
          cause instanceof Error && cause.message !== m["app.transactionFilters.invalidUrl"]()
            ? cause.message
            : m["app.transactionFilters.invalidDates"](),
      })
    }
  }
  const applyYear = (value: string) =>
    apply("year", () => transactionYearFilters({ filters, year: value }))
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm wrap-anywhere">{m["app.transactionFilters.timezone"]({ timezone })}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          onClick={() => applyYear(String(transactionFilterYear({ timezone })))}
        >
          {m["app.transactionFilters.thisYear"]()}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          onClick={() => applyYear(String(transactionFilterYear({ timezone }) - 1))}
        >
          {m["app.transactionFilters.lastYear"]()}
        </Button>
      </div>
      <form
        className="flex min-w-0 flex-col gap-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          applyYear(year)
        }}
      >
        <label htmlFor={`${id}-year`}>{m["app.transactionFilters.specificYear"]()}</label>
        <Input
          id={`${id}-year`}
          value={year}
          inputMode="numeric"
          autoComplete="off"
          className="min-h-11"
          disabled={disabled}
          aria-invalid={error?.form === "year"}
          aria-describedby={error?.form === "year" ? `${id}-year-error` : undefined}
          onChange={(event) => {
            setYear(event.target.value)
            setError(undefined)
          }}
        />
        {error?.form === "year" ? (
          <p
            id={`${id}-year-error`}
            role="alert"
            className="text-sm text-destructive"
            ref={(node) => node?.scrollIntoView({ block: "nearest", behavior: "instant" })}
          >
            {error.message}
          </p>
        ) : null}
        <Button type="submit" variant="outline" className="min-h-11" disabled={disabled}>
          {m["app.transactionFilters.applyYear"]()}
        </Button>
      </form>
      <form
        className="flex min-w-0 flex-col gap-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!event.currentTarget.checkValidity()) {
            setError({ form: "range", message: m["app.transactionFilters.invalidDates"]() })
            return
          }
          apply("range", () =>
            parseTransactionFilters({
              ...filters,
              from: from || undefined,
              to: to || undefined,
              timezone,
            })
          )
        }}
      >
        {textDates ? (
          <p id={`${id}-date-format`} className="text-sm text-muted-foreground">
            {m["app.transactionFilters.dateFormat"]()}
          </p>
        ) : null}
        <label htmlFor={`${id}-from`}>{m["app.transactionFilters.fromDate"]()}</label>
        <Input
          id={`${id}-from`}
          type={textDates ? "text" : "date"}
          value={from}
          className="min-h-11 px-2"
          disabled={disabled}
          aria-invalid={error?.form === "range"}
          aria-describedby={
            error?.form === "range"
              ? `${id}-range-error`
              : textDates
                ? `${id}-date-format`
                : undefined
          }
          onChange={(event) => {
            setFrom(event.target.value)
            setError(undefined)
          }}
        />
        <label htmlFor={`${id}-to`}>{m["app.transactionFilters.toDate"]()}</label>
        <Input
          id={`${id}-to`}
          type={textDates ? "text" : "date"}
          value={to}
          className="min-h-11 px-2"
          disabled={disabled}
          aria-invalid={error?.form === "range"}
          aria-describedby={
            error?.form === "range"
              ? `${id}-range-error`
              : textDates
                ? `${id}-date-format`
                : undefined
          }
          onChange={(event) => {
            setTo(event.target.value)
            setError(undefined)
          }}
        />
        {error?.form === "range" ? (
          <p
            id={`${id}-range-error`}
            role="alert"
            className="text-sm text-destructive"
            ref={(node) => node?.scrollIntoView({ block: "nearest", behavior: "instant" })}
          >
            {error.message}
          </p>
        ) : null}
        <Button type="submit" className="min-h-11" disabled={disabled}>
          {m["app.transactionFilters.applyRange"]()}
        </Button>
      </form>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        disabled={disabled}
        onClick={() => onApply({ ...filters, from: undefined, to: undefined })}
      >
        {m["app.transactionFilters.clearDates"]()}
      </Button>
    </div>
  )
}

function DateFilterMenu({
  filters,
  onChange,
  disabled,
}: {
  filters: TransactionFilters
  onChange: (filters: TransactionFilters) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const range =
    filters.from && filters.to
      ? m["app.transactionFilters.dateRange"]({ from: filters.from, to: filters.to })
      : filters.from
        ? m["app.transactionFilters.fromSummary"]({ date: filters.from })
        : filters.to
          ? m["app.transactionFilters.toSummary"]({ date: filters.to })
          : m["app.transactionFilters.allDates"]()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          aria-label={m["app.transactionFilters.editDates"]()}
          className="h-auto min-h-11 max-w-full whitespace-normal text-left"
        >
          <span className="min-w-0 wrap-anywhere">{range}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        aria-label={m["app.transactionFilters.editDates"]()}
        className="max-h-(--radix-popover-content-available-height) w-88 max-w-[calc(100vw-2rem)] overflow-y-auto motion-reduce:[--tw-enter-scale:1]! motion-reduce:[--tw-exit-scale:1]! motion-reduce:[--tw-enter-translate-x:0]! motion-reduce:[--tw-enter-translate-y:0]! motion-reduce:[--tw-exit-translate-x:0]! motion-reduce:[--tw-exit-translate-y:0]!"
      >
        <DateFilterForm
          key={JSON.stringify([filters.from, filters.to, filters.timezone])}
          filters={filters}
          disabled={disabled}
          onApply={(next) => {
            onChange(next)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** Controlled chips share the route's filter state with source cards and both readers. */
export function TransactionFilterControls({
  filters,
  onChange,
  sources,
  assets,
  loading = false,
  failed = false,
  onRetry,
  disabled = false,
}: {
  filters: TransactionFilters
  onChange: (filters: TransactionFilters) => void
  sources: ReadonlyArray<Account>
  assets?: TransactionFilterChoices["assets"]
  loading?: boolean
  failed?: boolean
  onRetry: () => void
  disabled?: boolean
}) {
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const focusAfterKeyboardAction = (event: MouseEvent<HTMLButtonElement>, group: string) => {
    if (event.detail === 0) triggers.current.get(group)?.focus()
  }
  const labels = categoryLabels()
  const sourceNameCounts = new Map<string, number>()
  for (const source of sources) {
    sourceNameCounts.set(source.name, (sourceNameCounts.get(source.name) ?? 0) + 1)
  }
  const sourceChoices = sources.map((source) => ({
    id: source.id,
    label: source.name,
    detail: (sourceNameCounts.get(source.name) ?? 0) > 1 ? source.id : undefined,
  }))
  const assetMetadataKey = (asset: TransactionFilterChoices["assets"][number]) =>
    JSON.stringify([asset.symbol, asset.name, asset.type, asset.coingeckoCoinId])
  const assetMetadataCounts = new Map<string, number>()
  for (const asset of assets ?? []) {
    const key = assetMetadataKey(asset)
    assetMetadataCounts.set(key, (assetMetadataCounts.get(key) ?? 0) + 1)
  }
  const assetChoices = (assets ?? []).map((asset) => {
    const indistinguishable = (assetMetadataCounts.get(assetMetadataKey(asset)) ?? 0) > 1
    const metadata = [
      asset.type === "nft"
        ? m["app.transactionFilters.nft"]()
        : m["app.transactionFilters.token"](),
      asset.coingeckoCoinId,
      indistinguishable ? asset.assetId : null,
    ]
      .filter(Boolean)
      .join(" · ")
    return { id: asset.assetId, label: `${asset.symbol} · ${asset.name}`, detail: metadata }
  })
  const categories = (
    [
      "purchase",
      "sale",
      "gift",
      "airdrop",
      "mining_reward",
      "staking",
      "staking_reward",
      "passive_staking_reward",
      "reward",
      "payment",
      "unknown",
      "custody_movement",
    ] as const
  ).map((id) => ({ id, label: labels[id] }))
  const changeIds = (group: "sourceIds" | "assetIds", id: string) => {
    const current = filters[group] ?? []
    onChange({
      ...filters,
      [group]: current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id].sort(),
    })
  }
  const toggleCategory = (id: string) => {
    const category = categories.find((choice) => choice.id === id)?.id
    if (!category) return
    const current = filters.categories ?? []
    onChange({
      ...filters,
      categories: current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category].sort(),
    })
  }
  const groups = [
    {
      key: "sourceIds",
      label: m["app.transactionFilters.sources"](),
      choices: sourceChoices,
      selected: filters.sourceIds ?? [],
      toggle: (id: string) => changeIds("sourceIds", id),
    },
    {
      key: "assetIds",
      label: m["app.transactionFilters.assets"](),
      choices: assetChoices,
      selected: filters.assetIds ?? [],
      toggle: (id: string) => changeIds("assetIds", id),
    },
    {
      key: "categories",
      label: m["app.transactionFilters.categories"](),
      choices: categories,
      selected: filters.categories ?? [],
      toggle: toggleCategory,
    },
  ]
  const hasFilters = Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined
  )
  return (
    <section
      aria-label={m["app.transactionFilters.title"]()}
      className="mb-5 flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {groups.map((group) => (
          <FilterMenu
            key={group.key}
            triggerRef={(node) => {
              if (node) triggers.current.set(group.key, node)
              else triggers.current.delete(group.key)
            }}
            label={group.label}
            choices={group.choices}
            selected={group.selected}
            onToggle={group.toggle}
            disabled={disabled}
            loading={group.key === "assetIds" && loading}
            failed={group.key === "assetIds" && failed}
            onRetry={onRetry}
          />
        ))}
        <DateFilterMenu filters={filters} onChange={onChange} disabled={disabled} />
        <Select
          value={filters.order ?? "newest"}
          disabled={disabled}
          onValueChange={(order) => {
            if (order === "newest" || order === "oldest") onChange({ ...filters, order })
          }}
        >
          <SelectTrigger aria-label={m["app.transactionFilters.order"]()} className="min-h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="motion-reduce:[--tw-enter-scale:1]! motion-reduce:[--tw-exit-scale:1]!">
            <SelectGroup>
              <SelectItem value="newest" className="min-h-11">
                {m["app.transactionFilters.newest"]()}
              </SelectItem>
              <SelectItem value="oldest" className="min-h-11">
                {m["app.transactionFilters.oldest"]()}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3">
          <Checkbox
            checked={filters.attention === true}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({ ...filters, attention: checked === true ? true : undefined })
            }
          />
          {m["app.transactionFilters.attention"]()}
        </label>
        {hasFilters ? (
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={disabled}
            onClick={(event) => {
              focusAfterKeyboardAction(event, "sourceIds")
              onChange({})
            }}
          >
            {m["app.transactionFilters.reset"]()}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground wrap-anywhere">
        {m["app.transactionFilters.timezone"]({ timezone: filters.timezone ?? "Europe/Berlin" })}
      </p>
      <div className="flex flex-wrap gap-2">
        {groups.flatMap((group) => {
          const choicesById = new Map<string, Choice>(
            group.choices.map((choice) => [choice.id, choice])
          )
          const labelCounts = new Map<string, number>()
          for (const choice of group.choices) {
            labelCounts.set(choice.label, (labelCounts.get(choice.label) ?? 0) + 1)
          }
          return group.selected.map((id) => {
            const choice = choicesById.get(id)
            const duplicate = choice && (labelCounts.get(choice.label) ?? 0) > 1
            const label = choice
              ? `${choice.label}${duplicate ? ` · ${choice.detail ?? id}` : ""}`
              : `${group.label} · ${id}`
            return (
              <Button
                key={`${group.key}-${id}`}
                variant="secondary"
                disabled={disabled}
                className="h-auto min-h-11 max-w-full whitespace-normal text-left"
                aria-label={m["app.transactionFilters.remove"]({ value: label })}
                onClick={(event) => {
                  focusAfterKeyboardAction(event, group.key)
                  group.toggle(id)
                }}
              >
                <span className="min-w-0 wrap-anywhere">{label}</span>
                <X data-icon="inline-end" />
              </Button>
            )
          })
        })}
      </div>
      {!filters.categories?.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {m["app.transactionFilters.suggestions"]()}
          </span>
          {(["staking", "sale", "custody_movement"] as const).map((category) => (
            <Button
              key={category}
              variant="ghost"
              className="min-h-11"
              disabled={disabled}
              onClick={(event) => {
                focusAfterKeyboardAction(event, "categories")
                onChange({ ...filters, categories: [category] })
              }}
            >
              {labels[category]}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  )
}
