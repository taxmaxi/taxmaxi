import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Show, type ParentProps } from "solid-js"
import { theme } from "../theme.ts"

const DEFAULT_WIDTH = 56

export function Dialog(props: ParentProps<{ readonly title?: string; readonly width?: number }>) {
  const dimensions = useTerminalDimensions()
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
        border
        borderStyle="rounded"
        borderColor={theme.border}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <Show when={props.title}>
          <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
        </Show>
        {props.children}
      </box>
    </box>
  )
}
