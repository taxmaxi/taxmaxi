import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Show } from "solid-js"
import { LOGO_HEIGHT } from "../logo.ts"
import { theme } from "../theme.ts"
import { Logo } from "../ui/Logo.tsx"

// The welcome panel needs roughly this many rows on its own (header, panel
// border, copy, and key hints). Only show the logo above it when the terminal
// is tall enough to fit both without clipping.
const PANEL_RESERVED_ROWS = 12

export function WelcomeScreen(props: {
  readonly note: string | undefined
  readonly active: () => boolean
  readonly onConnect: () => void
  readonly onQuit: () => void
}) {
  const dimensions = useTerminalDimensions()
  const showLogo = () => dimensions().height >= LOGO_HEIGHT + PANEL_RESERVED_ROWS

  useKeyboard((evt) => {
    if (!props.active()) {
      return
    }
    if (evt.name === "return") {
      props.onConnect()
      return
    }
    if (evt.name === "q") {
      props.onQuit()
    }
  })

  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" gap={1}>
      <Show when={showLogo()}>
        <Logo />
      </Show>
      <box
        flexDirection="column"
        gap={1}
        width={60}
        backgroundColor={theme.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={theme.border}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={theme.textCream} attributes={TextAttributes.BOLD}>
          Welcome to TaxMaxi
        </text>
        <Show when={props.note}>
          <text fg={theme.warning} wrapMode="word">
            {props.note}
          </text>
        </Show>
        <text fg={theme.textSecondary} wrapMode="word">
          Connect your Coinbase account to import transactions and calculate crypto taxes right from
          your terminal.
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={theme.accent}>[enter] connect Coinbase</text>
          <text fg={theme.textMuted}>[q] quit</text>
        </box>
      </box>
    </box>
  )
}
