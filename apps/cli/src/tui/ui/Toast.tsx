/**
 * Transient top-right notification overlay, modeled after opencode's toast.
 *
 * `createToast` owns the state: showing a toast replaces the current one
 * and auto-dismisses it after its duration.
 */
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { theme } from "../theme.ts"

const DEFAULT_DURATION_MS = 5000

// Only a heavy vertical bar on the left/right edges, like opencode's split border.
const SPLIT_BORDER_CHARS = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "┃",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
}

export type ToastVariant = "info" | "success" | "warning" | "error"

export type ToastOptions = {
  readonly title?: string
  readonly message: string
  readonly variant: ToastVariant
  readonly durationMs?: number
}

export type ToastHandle = {
  readonly current: () => ToastOptions | undefined
  readonly show: (options: ToastOptions) => void
}

/**
 * Creates the toast state rendered by {@link Toast}.
 */
export function createToast(): ToastHandle {
  const [current, setCurrent] = createSignal<ToastOptions | undefined>(undefined)
  let dismissHandle: ReturnType<typeof setTimeout> | undefined
  const show = (options: ToastOptions) => {
    setCurrent(options)
    if (dismissHandle !== undefined) {
      clearTimeout(dismissHandle)
    }
    dismissHandle = setTimeout(() => {
      setCurrent(undefined)
    }, options.durationMs ?? DEFAULT_DURATION_MS)
    dismissHandle.unref()
  }
  return { current, show }
}

const variantColor: Record<ToastVariant, string> = {
  info: theme.accent,
  success: theme.success,
  warning: theme.warning,
  error: theme.error,
}

export function Toast(props: { readonly toast: ToastHandle }) {
  const dimensions = useTerminalDimensions()
  return (
    <Show when={props.toast.current()} keyed>
      {(current: ToastOptions) => (
        <box
          position="absolute"
          top={2}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundPanel}
          border={["left", "right"]}
          borderColor={variantColor[current.variant]}
          customBorderChars={SPLIT_BORDER_CHARS}
        >
          <Show when={current.title} keyed>
            {(title: string) => (
              <text attributes={TextAttributes.BOLD} fg={theme.text}>
                {title}
              </text>
            )}
          </Show>
          <text fg={theme.text} wrapMode="word">
            {current.message}
          </text>
        </box>
      )}
    </Show>
  )
}
