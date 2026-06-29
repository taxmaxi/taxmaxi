import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createContext, createSignal, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { theme } from "../theme.ts"

const DEFAULT_WIDTH = 56

type DialogEntry = {
  readonly render: () => JSX.Element
}

export type DialogContext = Readonly<{
  readonly open: boolean
  replace: (render: () => JSX.Element) => void
  clear: () => void
}>

const DialogContext = createContext<DialogContext>()

export function Dialog(props: ParentProps<{ readonly title?: string; readonly width?: number }>) {
  const dimensions = useTerminalDimensions()
  const dialog = useContext(DialogContext)
  const width = () => Math.min(props.width ?? DEFAULT_WIDTH, dimensions().width - 4)

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      paddingTop={Math.max(1, Math.floor(dimensions().height / 5))}
      zIndex={100}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        width={width()}
        flexDirection="column"
        gap={1}
        backgroundColor={theme.backgroundPanel}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <Show when={props.title} fallback={<text />}>
            <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
              {props.title}
            </text>
          </Show>
          <text fg={theme.textMuted} onMouseUp={() => dialog?.clear()}>
            esc
          </text>
        </box>
        {props.children}
      </box>
    </box>
  )
}

export function DialogProvider(props: ParentProps): JSX.Element {
  const [stack, setStack] = createSignal<ReadonlyArray<DialogEntry>>([])
  const value: DialogContext = {
    get open() {
      return stack().length > 0
    },
    replace(render) {
      setStack([{ render }])
    },
    clear() {
      setStack([])
    },
  }
  const current = () => stack().at(-1)

  return (
    <DialogContext.Provider value={value}>
      {props.children}
      <Show when={current()} keyed>
        {(entry: DialogEntry) => entry.render()}
      </Show>
    </DialogContext.Provider>
  )
}

export function useDialog(): DialogContext {
  const value = useContext(DialogContext)
  if (value === undefined) {
    throw new Error("useDialog must be used within DialogProvider")
  }
  return value
}
