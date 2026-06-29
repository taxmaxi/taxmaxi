import { TextAttributes, type MouseEvent } from "@opentui/core"
import { For, Show, type ParentProps } from "solid-js"
import { theme } from "../theme.ts"

/**
 * Shared layout for the report screens: a bordered panel with a title row
 * and a key-hint footer below it.
 */
export function ScreenFrame(
  props: ParentProps<{
    readonly title: string
    readonly subtitle?: string
    readonly hints: ReadonlyArray<string>
    readonly onMouseScroll?: (event: MouseEvent) => void
  }>
) {
  return (
    <box
      flexGrow={1}
      flexShrink={1}
      flexDirection="column"
      minHeight={0}
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      onMouseScroll={(event) => props.onMouseScroll?.(event)}
    >
      <box
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
        minHeight={0}
        gap={1}
        backgroundColor={theme.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={theme.border}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <box flexDirection="row" gap={2}>
          <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
          <Show when={props.subtitle}>
            <text fg={theme.textMuted}>{props.subtitle}</text>
          </Show>
        </box>
        {props.children}
      </box>
      <box flexDirection="row" gap={2} paddingLeft={1}>
        <For each={props.hints}>{(hint) => <text fg={theme.textMuted}>{hint}</text>}</For>
      </box>
    </box>
  )
}
