import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { theme } from "../theme.ts"
import { ListItem, ListItemText } from "./ListItem.tsx"

export type DialogSelectOption<T> = {
  readonly title: string
  readonly value: T
  readonly badge?: string
  readonly category?: string
  /** Renders the option dimmed, for entries that only show a hint when picked. */
  readonly muted?: boolean
}

type DialogSelectGroup<T> = {
  readonly category: string | undefined
  readonly options: ReadonlyArray<DialogSelectOption<T>>
}

export function DialogSelect<T>(props: {
  readonly options: ReadonlyArray<DialogSelectOption<T>>
  readonly onSelect: (value: T) => void
  readonly onCancel: () => void
  readonly filterable?: boolean
  readonly placeholder?: string
}) {
  const [index, setIndex] = createSignal(0)
  const [query, setQuery] = createSignal("")
  const [cursorVisible, setCursorVisible] = createSignal(true)
  const filteredOptions = createMemo(() => {
    const trimmed = query().trim().toLowerCase()
    if (trimmed.length === 0) {
      return props.options
    }
    return props.options.filter((option) => {
      const haystack = `${option.title} ${option.badge ?? ""}`.toLowerCase()
      return haystack.includes(trimmed)
    })
  })
  const groupedOptions = createMemo(() => {
    const groups: Array<DialogSelectGroup<T>> = []
    for (const option of filteredOptions()) {
      const group = groups.find((item) => item.category === option.category)
      if (group !== undefined) {
        groups[groups.indexOf(group)] = {
          category: group.category,
          options: [...group.options, option],
        }
        continue
      }
      groups.push({ category: option.category, options: [option] })
    }
    return groups
  })

  createEffect(() => {
    query()
    props.options
    setIndex(0)
  })

  const cursorTimer = setInterval(() => setCursorVisible((visible) => !visible), 530)
  onCleanup(() => clearInterval(cursorTimer))

  const cursorStyle = () =>
    cursorVisible()
      ? { bg: theme.textSecondary, fg: theme.background }
      : { bg: theme.backgroundPanel, fg: theme.textMuted }

  useKeyboard((evt) => {
    if (evt.name === "up") {
      const options = filteredOptions()
      if (options.length > 0) {
        setIndex((current) => (current + options.length - 1) % options.length)
      }
      return
    }
    if (evt.name === "down") {
      const options = filteredOptions()
      if (options.length > 0) {
        setIndex((current) => (current + 1) % options.length)
      }
      return
    }
    if (evt.name === "return") {
      const option = filteredOptions()[index()]
      if (option !== undefined) {
        props.onSelect(option.value)
      }
      return
    }
    if (evt.name === "escape") {
      props.onCancel()
      return
    }
    if (props.filterable === true && evt.name === "backspace") {
      setQuery((current) => current.slice(0, -1))
      return
    }
    if (
      props.filterable === true &&
      !evt.ctrl &&
      !evt.meta &&
      !evt.option &&
      evt.raw.length === 1 &&
      evt.raw >= " " &&
      evt.raw !== "\x7f"
    ) {
      setQuery((current) => `${current}${evt.raw}`)
    }
  })

  return (
    <box flexDirection="column" width="100%">
      <Show when={props.filterable === true}>
        <box paddingLeft={1} paddingRight={1} paddingBottom={1}>
          <text>
            <Show
              when={query().length > 0}
              fallback={
                <>
                  <span style={cursorStyle()}>{(props.placeholder ?? "Search").slice(0, 1)}</span>
                  <span style={{ fg: theme.textMuted }}>
                    {(props.placeholder ?? "Search").slice(1)}
                  </span>
                </>
              }
            >
              <span style={{ fg: theme.textSoft }}>{query()}</span>
              <span style={cursorStyle()}> </span>
            </Show>
          </text>
        </box>
      </Show>
      <For each={groupedOptions()}>
        {(group, groupIndex) => (
          <>
            <Show when={group.category}>
              <box paddingLeft={1} paddingRight={1} paddingTop={groupIndex() > 0 ? 1 : 0}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  {group.category}
                </text>
              </box>
            </Show>
            <For each={group.options}>
              {(option) => {
                const optionIndex = () => filteredOptions().indexOf(option)
                const isSelected = () => optionIndex() === index()
                return (
                  <ListItem selected={isSelected()} fullWidth justifyContent="space-between">
                    <box flexDirection="row" gap={1}>
                      <ListItemText selected={isSelected()} muted={option.muted}>
                        {option.title}
                      </ListItemText>
                    </box>
                    <Show when={option.badge}>
                      <ListItemText
                        selected={isSelected()}
                        muted={option.muted}
                        color={theme.accent}
                      >
                        {option.badge}
                      </ListItemText>
                    </Show>
                  </ListItem>
                )
              }}
            </For>
          </>
        )}
      </For>
      <Show when={props.filterable === true && filteredOptions().length === 0}>
        <box paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text fg={theme.textMuted}>No matches</text>
        </box>
      </Show>
    </box>
  )
}
