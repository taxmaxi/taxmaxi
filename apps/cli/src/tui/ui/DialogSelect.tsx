import { useKeyboard } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { theme } from "../theme.ts"

export type DialogSelectOption<T> = {
  readonly title: string
  readonly value: T
  readonly badge?: string
  /** Renders the option dimmed, for entries that only show a hint when picked. */
  readonly muted?: boolean
}

export function DialogSelect<T>(props: {
  readonly options: ReadonlyArray<DialogSelectOption<T>>
  readonly onSelect: (value: T) => void
  readonly onCancel: () => void
}) {
  const [index, setIndex] = createSignal(0)

  useKeyboard((evt) => {
    if (evt.name === "up") {
      setIndex((current) => (current + props.options.length - 1) % props.options.length)
      return
    }
    if (evt.name === "down") {
      setIndex((current) => (current + 1) % props.options.length)
      return
    }
    if (evt.name === "return") {
      const option = props.options[index()]
      if (option !== undefined) {
        props.onSelect(option.value)
      }
      return
    }
    if (evt.name === "escape") {
      props.onCancel()
    }
  })

  return (
    <box flexDirection="column">
      <For each={props.options}>
        {(option, optionIndex) => {
          const isSelected = () => optionIndex() === index()
          return (
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isSelected() ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={isSelected() ? theme.text : theme.textMuted}>
                {isSelected() ? "›" : " "}
              </text>
              <text
                fg={
                  isSelected()
                    ? theme.text
                    : option.muted === true
                      ? theme.textMuted
                      : theme.textSoft
                }
              >
                {option.title}
              </text>
              <Show when={option.badge}>
                <text fg={option.muted === true ? theme.textMuted : theme.accent}>
                  {option.badge}
                </text>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}
