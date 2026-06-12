import { createSignal, onCleanup, Show } from "solid-js"
import { theme } from "../theme.ts"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const FRAME_INTERVAL_MILLIS = 80

export function Spinner(props: { readonly label?: string; readonly color?: string }) {
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(
    () => setFrame((current) => (current + 1) % FRAMES.length),
    FRAME_INTERVAL_MILLIS
  )
  onCleanup(() => clearInterval(timer))

  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.color ?? theme.accent}>{FRAMES[frame()] ?? ""}</text>
      <Show when={props.label}>
        <text fg={theme.textMuted}>{props.label}</text>
      </Show>
    </box>
  )
}
