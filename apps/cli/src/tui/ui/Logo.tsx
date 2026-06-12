import { For } from "solid-js"
import { LOGO_LINES, LOGO_WIDTH } from "../logo.ts"
import { theme } from "../theme.ts"

/**
 * Renders the TaxMaxi brand mark in the accent color. Each art line is one
 * text row; spaces stay transparent so the figure reads against any surface.
 */
export function Logo(props: { readonly color?: string }) {
  return (
    <box flexDirection="column" width={LOGO_WIDTH} alignItems="flex-start">
      <For each={LOGO_LINES}>{(line) => <text fg={props.color ?? theme.accent}>{line}</text>}</For>
    </box>
  )
}
